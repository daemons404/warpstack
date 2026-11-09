import type { Fid } from '@warpstack/protocol'
import { SESSION_TTL, SIGNER_RECHECK, SIGNER_STALE_MAX } from './core/session.ts'
import { ownMessageOf, type OwnMessage } from './core/own.ts'
import { NOTE, type InboundStep, type Note, type NoteKind } from './core/inbound.ts'
import type { MessagePage, PageRequest, Snapchain, SyncSql, UpstreamResult } from './ports.ts'

// The user object's state: one SQLite database per FID, the only place
// a user's private server state lives. This class is the object's logic over a synchronous
// SQLite (`SyncSql`); `user-object.ts` hosts it in a Durable Object and tests host it on
// node:sqlite. Hashes are lowercase 0x-hex TEXT, as in the cast index.
//
// M2 fills sessions, challenges, the own history (casts, reactions, links, merged hashes) and
// devices. The inbox, outbox, mini-app and settings tables exist with the design's schema and
// are filled by notifications, push and mini apps.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS applied      (shard INTEGER PRIMARY KEY, last_event_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS my_casts     (hash TEXT PRIMARY KEY, ts INTEGER NOT NULL, parent_hash TEXT, channel TEXT,
                                         text TEXT, embeds TEXT);
CREATE INDEX IF NOT EXISTS my_casts_ts  ON my_casts(ts DESC);
CREATE TABLE IF NOT EXISTS my_reactions (target_hash TEXT NOT NULL, kind INTEGER NOT NULL, ts INTEGER NOT NULL, hash TEXT NOT NULL,
                                         PRIMARY KEY (target_hash, kind));
CREATE INDEX IF NOT EXISTS my_reactions_ts   ON my_reactions(ts DESC);
CREATE INDEX IF NOT EXISTS my_reactions_hash ON my_reactions(hash);
CREATE TABLE IF NOT EXISTS links        (target_fid INTEGER NOT NULL, kind INTEGER NOT NULL,
                                         ts INTEGER NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (target_fid, kind));
CREATE INDEX IF NOT EXISTS links_hash   ON links(hash);
CREATE TABLE IF NOT EXISTS own_messages (hash TEXT PRIMARY KEY, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS own_messages_ts ON own_messages(ts);
CREATE TABLE IF NOT EXISTS inbox (source TEXT NOT NULL, kind INTEGER NOT NULL, actor_fid INTEGER NOT NULL, target TEXT,
                                  group_key TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (source, kind));
CREATE INDEX IF NOT EXISTS inbox_ts ON inbox(ts);
CREATE TABLE IF NOT EXISTS inbox_groups (group_key TEXT PRIMARY KEY, kind INTEGER NOT NULL, target TEXT, latest_ts INTEGER NOT NULL,
                                         count INTEGER NOT NULL, actors TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS inbox_groups_latest ON inbox_groups(latest_ts DESC);
CREATE INDEX IF NOT EXISTS inbox_groups_unseen ON inbox_groups(seen, latest_ts);
CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                                   next_ts INTEGER NOT NULL, created_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS devices       (device_id TEXT PRIMARY KEY, platform TEXT, push_token TEXT, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS miniapps      (app_domain TEXT PRIMARY KEY, added INTEGER NOT NULL, notifications INTEGER NOT NULL,
                                          token_gen INTEGER NOT NULL, sent_day INTEGER, sent_count INTEGER, last_sent_ts INTEGER);
CREATE TABLE IF NOT EXISTS miniapp_ops   (op_id TEXT PRIMARY KEY, app_domain TEXT NOT NULL, event TEXT NOT NULL,
                                          expect_gen INTEGER NOT NULL, new_gen INTEGER, expires_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notified      (app_domain TEXT NOT NULL, notification_id TEXT NOT NULL, ts INTEGER NOT NULL,
                                          PRIMARY KEY (app_domain, notification_id));
CREATE TABLE IF NOT EXISTS sessions      (token_hash TEXT PRIMARY KEY, app_key TEXT NOT NULL, device_id TEXT NOT NULL,
                                          custody TEXT NOT NULL, created_ts INTEGER NOT NULL, expires_ts INTEGER NOT NULL,
                                          last_seen_ts INTEGER NOT NULL, request_fid INTEGER);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_ts);
CREATE TABLE IF NOT EXISTS used_challenges (nonce TEXT PRIMARY KEY, expires_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings      (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta          (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`

/** How much of the user's own history the backfill reads per kind before it records a gap. */
export const BACKFILL_MAX = 10_000
const BACKFILL_PAGE = 1_000
/** How long merged hashes are kept for `messages.status`. */
const OWN_MESSAGES_SECONDS = 24 * 60 * 60
const VIEWER_MAX = { reactions: 1_000, links: 5_000 } as const

export type History = 'backfilling' | 'complete' | 'gap'
/** `requestFid`: the app FID that requested the session's key, if any, so admission can be rechecked on every request. */
export type AuthResult = { ok: true; appKey: string; requestFid: number | null } | { ok: false; reason: 'session' | 'upstream' }
/** A queued own-history step, as ingestion stores it in D1. */
export type Delivery = { shard: number; event_id: number; seq: number; payload: string }
export type { SignerCheck }
export type SessionOpen = {
  nonce: string; nonceExpires: number; tokenHash: string; appKey: string; device: string; custody: string; now: number
  /** The FID that requested the key, from the node's signer list. */
  requestFid?: number | undefined
}

type SignerCheck = { keys: Set<string>; custody: string | null; requestFids: Map<string, number> }

/** Actors kept per group, newest first: the screen shows a few faces and a count. */
export const GROUP_ACTORS = 10
/** Notification retention. */
export const INBOX_DAYS = 30

const KIND_NAMES = Object.fromEntries(Object.entries(NOTE).map(([k, v]) => [v, k])) as Record<number, NoteKind>

/** Likes and recasts group per cast, follows per day; replies, mentions and quotes stand alone. */
const groupKeyOf = (n: Note): string =>
  n.kind === 'like' || n.kind === 'recast' ? `${n.kind}:${n.target?.hash ?? n.source}`
    : n.kind === 'follow' ? `follow:${Math.floor(n.ts / 86_400)}`
    : `${n.kind}:${n.source}`

export type InboxGroup = {
  key: string
  kind: NoteKind
  ts: number
  count: number
  /** Newest first, at most GROUP_ACTORS. */
  actors: number[]
  /** The cast it's about: the user's own for likes and recasts, the new one otherwise. */
  target: { fid: number; hash: string } | null
  seen: boolean
}

export class UserStore {
  constructor(private readonly sql: SyncSql, readonly fid: Fid) {
    for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) this.sql.run(stmt)
    // Objects created before sessions recorded the requesting FID gain the column.
    if (!this.sql.all<{ name: string }>('SELECT name FROM pragma_table_info(\'sessions\')').some(c => c.name === 'request_fid')) {
      this.sql.run('ALTER TABLE sessions ADD COLUMN request_fid INTEGER')
    }
  }

  private meta(k: string): string | null {
    return this.sql.all<{ v: string }>('SELECT v FROM meta WHERE k = ?', k)[0]?.v ?? null
  }

  private setMeta(k: string, v: string | number) {
    this.sql.run('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, String(v))
  }

  history(): History | null {
    return this.meta('history') as History | null
  }

  /** The earliest time the object needs waking: a session or challenge expiry. */
  nextDeadline(): number | null {
    const [r] = this.sql.all<{ t: number | null }>(
      'SELECT min(t) AS t FROM (SELECT min(expires_ts) AS t FROM sessions UNION ALL SELECT min(expires_ts) FROM used_challenges)')
    return r?.t ?? null
  }

  /** Drops expired sessions, spent challenges and old merged hashes. */
  prune(now: number) {
    this.sql.run('DELETE FROM sessions WHERE expires_ts <= ?', now)
    this.sql.run('DELETE FROM used_challenges WHERE expires_ts <= ?', now)
    this.sql.run('DELETE FROM own_messages WHERE ts < ?', now - OWN_MESSAGES_SECONDS)
  }

  /**
   * Records the challenge's nonce and stores the new session's hash, after the Worker has
   * verified the challenge, the signature, the key and the custody. A Durable Object runs one
   * request at a time and this is one transaction, so of two verifies with one challenge,
   * exactly one succeeds. The first session starts the own-history backfill.
   */
  openSession(s: SessionOpen): { ok: true; expiresAt: number; backfill: boolean } | { ok: false } {
    return this.sql.transaction(() => {
      this.prune(s.now)
      if (this.sql.all('SELECT 1 FROM used_challenges WHERE nonce = ?', s.nonce).length) return { ok: false as const }
      this.sql.run('INSERT INTO used_challenges (nonce, expires_ts) VALUES (?, ?)', s.nonce, s.nonceExpires)
      const expiresAt = s.now + SESSION_TTL
      this.sql.run(`INSERT INTO sessions (token_hash, app_key, device_id, custody, created_ts, expires_ts, last_seen_ts, request_fid)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, s.tokenHash, s.appKey, s.device, s.custody, s.now, expiresAt, s.now, s.requestFid ?? null)
      this.sql.run(`INSERT INTO devices (device_id, ts) VALUES (?, ?) ON CONFLICT (device_id) DO UPDATE SET ts = excluded.ts`, s.device, s.now)
      // The Worker read the key and custody from the node just now.
      this.setMeta('signer_checked_ts', s.now)
      const backfill = this.history() === null
      if (backfill) this.setMeta('history', 'backfilling')
      return { ok: true as const, expiresAt, backfill }
    })
  }

  /**
   * Checks a session token's hash. When the last read of the key and custody is older than
   * `SIGNER_RECHECK`, it reads them again, and a removed key or a changed custody ends the
   * matching sessions. If no node answers, sessions keep working for `SIGNER_STALE_MAX` since
   * the last good read, then fail as upstream-unavailable.
   *
   * The read is awaited, so other requests can run meanwhile: a session opened during it was
   * checked fresh by its own verify, and this older read judges only the sessions it saw.
   */
  async authenticate(tokenHash: string, now: number, readSigners: () => Promise<SignerCheck | null>): Promise<AuthResult> {
    this.prune(now)
    const find = () => this.sql.all<{ app_key: string; request_fid: number | null }>(
      'SELECT app_key, request_fid FROM sessions WHERE token_hash = ? AND expires_ts > ?', tokenHash, now)[0]
    if (!find()) return { ok: false, reason: 'session' }
    const checked = Number(this.meta('signer_checked_ts') ?? 0)
    if (now - checked > SIGNER_RECHECK) {
      const seen = new Set(this.sql.all<{ token_hash: string }>('SELECT token_hash FROM sessions').map(r => r.token_hash))
      const fresh = await readSigners()
      if (fresh) this.applySignerCheck(fresh, now, seen)
      else if (now - checked > SIGNER_STALE_MAX) return { ok: false, reason: 'upstream' }
    }
    const s = find()
    if (!s) return { ok: false, reason: 'session' }
    this.sql.run('UPDATE sessions SET last_seen_ts = ? WHERE token_hash = ?', now, tokenHash)
    return { ok: true, appKey: s.app_key, requestFid: s.request_fid }
  }

  /**
   * Ends every session whose key is no longer active or whose custody changed. `only`: the
   * sessions that existed when `fresh` was read; later ones were checked by their own verify.
   */
  applySignerCheck(fresh: SignerCheck, now: number, only?: ReadonlySet<string>) {
    this.sql.transaction(() => {
      for (const s of this.sql.all<{ token_hash: string; app_key: string; custody: string }>('SELECT token_hash, app_key, custody FROM sessions')) {
        if (only && !only.has(s.token_hash)) continue
        if (!fresh.keys.has(s.app_key) || fresh.custody === null || fresh.custody !== s.custody) {
          this.sql.run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash)
        }
      }
      this.setMeta('signer_checked_ts', now)
    })
  }

  /** Ends this session and forgets its device's push token. Other devices stay signed in. */
  endSession(tokenHash: string) {
    this.sql.transaction(() => {
      const [s] = this.sql.all<{ device_id: string }>('SELECT device_id FROM sessions WHERE token_hash = ?', tokenHash)
      this.sql.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash)
      if (s) this.sql.run('UPDATE devices SET push_token = NULL WHERE device_id = ?', s.device_id)
    })
  }

  /**
   * Applies queued own-history steps in event order, exactly once: anything at or below a
   * shard's `applied` mark is skipped, and the steps and the mark commit together. Refused while
   * the backfill runs, so its snapshot lands first and later steps apply on top of it.
   */
  apply(deliveries: readonly Delivery[]): { ok: true } | { ok: false; reason: 'backfilling' } {
    if (this.history() === 'backfilling') return { ok: false, reason: 'backfilling' }
    this.sql.transaction(() => {
      const marks = new Map(this.sql.all<{ shard: number; last_event_id: number }>('SELECT shard, last_event_id FROM applied').map(r => [r.shard, r.last_event_id]))
      const sorted = [...deliveries].sort((a, b) => a.shard - b.shard || a.event_id - b.event_id || a.seq - b.seq)
      const done = new Map<number, number>()
      for (const d of sorted) {
        if (d.event_id <= (marks.get(d.shard) ?? 0)) continue
        const step = JSON.parse(d.payload) as { op: 'add' | 'remove'; msg: OwnMessage } | InboundStep
        if ('note' in step) {
          // A notification aimed at this user.
          if (step.note.to === this.fid) this.applyNote(step)
          done.set(d.shard, Math.max(done.get(d.shard) ?? 0, d.event_id))
          continue
        }
        if (step.msg.fid !== this.fid) continue
        if (step.op === 'add') {
          this.add(step.msg)
          this.sql.run('INSERT INTO own_messages (hash, ts) VALUES (?, ?) ON CONFLICT DO NOTHING', step.msg.hash, step.msg.ts)
        } else {
          this.remove(step.msg)
        }
        done.set(d.shard, Math.max(done.get(d.shard) ?? 0, d.event_id))
      }
      for (const [shard, id] of done) {
        this.sql.run('INSERT INTO applied (shard, last_event_id) VALUES (?, ?) ON CONFLICT (shard) DO UPDATE SET last_event_id = max(last_event_id, excluded.last_event_id)', shard, id)
      }
    })
    return { ok: true }
  }

  private add(m: OwnMessage) {
    if (m.kind === 'cast' && m.cast) {
      this.sql.run(`INSERT INTO my_casts (hash, ts, parent_hash, channel, text, embeds) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT (hash) DO NOTHING`, m.hash, m.ts, m.cast.parent_hash, m.cast.channel, m.cast.text, m.cast.embeds)
    } else if (m.kind === 'reaction' && m.reaction) {
      this.sql.run(`INSERT INTO my_reactions (target_hash, kind, ts, hash) VALUES (?, ?, ?, ?)
                    ON CONFLICT (target_hash, kind) DO UPDATE SET ts = excluded.ts, hash = excluded.hash WHERE excluded.ts >= ts`,
      m.reaction.target_hash, m.reaction.kind, m.ts, m.hash)
    } else if (m.kind === 'link' && m.link) {
      this.sql.run(`INSERT INTO links (target_fid, kind, ts, hash) VALUES (?, ?, ?, ?)
                    ON CONFLICT (target_fid, kind) DO UPDATE SET ts = excluded.ts, hash = excluded.hash WHERE excluded.ts >= ts`,
      m.link.target_fid, m.link.kind, m.ts, m.hash)
    }
  }

  /**
   * One notification in or out of the inbox, and its group kept current: likes and recasts
   * group per cast, follows per day, and replies, mentions and quotes are a group each. Adding
   * is constant-time (the count and newest actors are bumped); removing, which is rare,
   * recounts its group.
   */
  applyNote(step: InboundStep) {
    const n = step.note
    const kind = NOTE[n.kind]
    if (step.op === 'notify') {
      const key = groupKeyOf(n)
      const target = n.target ? `${n.target.fid}:${n.target.hash}` : null
      // A redelivered notification changes nothing.
      if (this.sql.all('SELECT 1 FROM inbox WHERE source = ? AND kind = ?', n.source, kind).length) return
      this.sql.run('INSERT INTO inbox (source, kind, actor_fid, target, group_key, ts) VALUES (?, ?, ?, ?, ?, ?)', n.source, kind, n.actor, target, key, n.ts)
      const [g] = this.sql.all<{ actors: string; latest_ts: number }>('SELECT actors, latest_ts FROM inbox_groups WHERE group_key = ?', key)
      const actors = [n.actor, ...(g ? (JSON.parse(g.actors) as number[]) : []).filter(a => a !== n.actor)].slice(0, GROUP_ACTORS)
      this.sql.run(`INSERT INTO inbox_groups (group_key, kind, target, latest_ts, count, actors, seen) VALUES (?, ?, ?, ?, 1, ?, 0)
                    ON CONFLICT (group_key) DO UPDATE SET
                      count = count + 1,
                      actors = CASE WHEN excluded.latest_ts >= latest_ts THEN excluded.actors ELSE actors END,
                      seen = CASE WHEN excluded.latest_ts > latest_ts THEN 0 ELSE seen END,
                      latest_ts = max(latest_ts, excluded.latest_ts)`,
      key, kind, target, n.ts, JSON.stringify(g && n.ts < g.latest_ts ? JSON.parse(g.actors) : actors))
      this.pruneInbox(n.ts)
    } else {
      const [row] = this.sql.all<{ group_key: string }>('SELECT group_key FROM inbox WHERE source = ? AND kind = ?', n.source, kind)
      if (!row) return
      this.sql.run('DELETE FROM inbox WHERE source = ? AND kind = ?', n.source, kind)
      this.recountGroup(row.group_key)
    }
  }

  private recountGroup(key: string) {
    const rows = this.sql.all<{ actor_fid: number; ts: number }>('SELECT actor_fid, ts FROM inbox WHERE group_key = ? ORDER BY ts DESC', key)
    if (!rows.length) {
      this.sql.run('DELETE FROM inbox_groups WHERE group_key = ?', key)
      return
    }
    const actors = [...new Set(rows.map(r => r.actor_fid))].slice(0, GROUP_ACTORS)
    this.sql.run('UPDATE inbox_groups SET count = ?, actors = ?, latest_ts = ? WHERE group_key = ?', rows.length, JSON.stringify(actors), rows[0]!.ts, key)
  }

  /** Notifications older than INBOX_DAYS go, measured from the newest one seen. */
  private pruneInbox(now: number) {
    const cutoff = now - INBOX_DAYS * 86_400
    this.sql.run('DELETE FROM inbox WHERE ts < ?', cutoff)
    this.sql.run('DELETE FROM inbox_groups WHERE latest_ts < ?', cutoff)
  }

  /** A page of grouped notifications, newest first, after `before` (latest_ts, group_key). */
  inbox(before: { ts: number; key: string } | null, limit: number): InboxGroup[] {
    return this.sql.all<{ group_key: string; kind: number; target: string | null; latest_ts: number; count: number; actors: string; seen: number }>(
      `SELECT group_key, kind, target, latest_ts, count, actors, seen FROM inbox_groups
       WHERE ? IS NULL OR latest_ts < ? OR (latest_ts = ? AND group_key < ?)
       ORDER BY latest_ts DESC, group_key DESC LIMIT ?`,
      before?.ts ?? null, before?.ts ?? 0, before?.ts ?? 0, before?.key ?? '', limit,
    ).map(r => {
      const [fid, hash] = r.target ? r.target.split(':') : []
      return {
        key: r.group_key, kind: KIND_NAMES[r.kind] ?? 'mention', ts: r.latest_ts, count: r.count,
        actors: JSON.parse(r.actors) as number[], seen: r.seen === 1,
        target: fid && hash ? { fid: Number(fid), hash } : null,
      }
    })
  }

  /** Whether the one-time fill from Snapchain has run. */
  inboxFilled(): boolean {
    return this.meta('inbox_filled') !== null
  }

  /**
   * The one-time fill: notifications from before the inbox existed, oldest first so groups end
   * with their newest actors. Steps already in the inbox change nothing. History arrives seen:
   * only what happens from now on is new.
   */
  fillInbox(notes: readonly Note[]): void {
    this.sql.transaction(() => {
      for (const n of [...notes].sort((a, b) => a.ts - b.ts)) if (n.to === this.fid) this.applyNote({ op: 'notify', note: n })
      this.sql.run('UPDATE inbox_groups SET seen = 1')
      this.setMeta('inbox_filled', 1)
    })
  }

  /** Marks every group up to `upTo` as seen. */
  markSeen(upTo: number): void {
    this.sql.run('UPDATE inbox_groups SET seen = 1 WHERE latest_ts <= ? AND seen = 0', upTo)
  }

  unseen(): number {
    return this.sql.all<{ n: number }>('SELECT count(*) AS n FROM inbox_groups WHERE seen = 0')[0]?.n ?? 0
  }

  /** Removes exactly the message the node dropped, by its hash. */
  private remove(m: OwnMessage) {
    if (m.kind === 'cast') this.sql.run('DELETE FROM my_casts WHERE hash = ?', m.hash)
    else if (m.kind === 'reaction') this.sql.run('DELETE FROM my_reactions WHERE hash = ?', m.hash)
    else if (m.kind === 'link') this.sql.run('DELETE FROM links WHERE hash = ?', m.hash)
  }

  /**
   * Reads the user's own casts, reactions, follows and blocks from the node and stores them in
   * one transaction. Past `BACKFILL_MAX` of a kind it stores what it read and records a gap.
   * `retry` means a node didn't answer, and nothing was stored.
   */
  async backfill(snapchain: Snapchain): Promise<History | 'retry'> {
    if (this.history() !== 'backfilling') return this.history() ?? 'retry'
    let gap = false
    const all = async (read: (p: PageRequest) => UpstreamResult<MessagePage>) => {
      const out: OwnMessage[] = []
      let token: string | undefined
      do {
        const r = await read({ size: BACKFILL_PAGE, reverse: true, token })
        if (!r.ok) return null
        out.push(...r.value.messages.map(ownMessageOf))
        token = r.value.next
      } while (token && out.length < BACKFILL_MAX)
      if (token) gap = true
      return out
    }
    const reads = await Promise.all([
      all(p => snapchain.castsByFid(this.fid, p)),
      all(p => snapchain.reactionsByFid(this.fid, 'like', p)),
      all(p => snapchain.reactionsByFid(this.fid, 'recast', p)),
      all(p => snapchain.linksByFid(this.fid, p, 'follow')),
      all(p => snapchain.linksByFid(this.fid, p, 'block')),
    ])
    if (reads.some(r => r === null)) return 'retry'
    const state: History = gap ? 'gap' : 'complete'
    this.sql.transaction(() => {
      for (const m of reads.flat() as OwnMessage[]) if (m.fid === this.fid) this.add(m)
      this.setMeta('history', state)
    })
    return state
  }

  /** Which of these hashes ingestion has seen merge, among the user's own messages from the last day. */
  status(hashes: readonly string[]): Record<string, 'merged' | 'unknown'> {
    const merged = new Set(this.sql.all<{ hash: string }>(
      `SELECT hash FROM own_messages WHERE hash IN (${hashes.map(() => '?').join(',') || 'NULL'})`, ...hashes).map(r => r.hash))
    return Object.fromEntries(hashes.map(h => [h, merged.has(h) ? 'merged' as const : 'unknown' as const]))
  }

  reactions(): { likes: string[]; recasts: string[]; history: History } {
    const rows = (kind: number) => this.sql.all<{ target_hash: string }>(
      'SELECT target_hash FROM my_reactions WHERE kind = ? ORDER BY ts DESC LIMIT ?', kind, VIEWER_MAX.reactions).map(r => r.target_hash)
    return { likes: rows(1), recasts: rows(2), history: this.history() ?? 'backfilling' }
  }

  links(): { following: number[]; blocking: number[]; history: History } {
    const rows = (kind: number) => this.sql.all<{ target_fid: number }>(
      'SELECT target_fid FROM links WHERE kind = ? ORDER BY ts DESC LIMIT ?', kind, VIEWER_MAX.links).map(r => r.target_fid)
    return { following: rows(1), blocking: rows(2), history: this.history() ?? 'backfilling' }
  }
}

/** Reads the FID's active keys and custody, or null if no node answered. */
export const readSignerCheck = async (snapchain: Snapchain, fid: Fid, now: number): Promise<SignerCheck | null> => {
  const [signers, custody] = await Promise.all([snapchain.signers(fid, [fid]), snapchain.custodyOf(fid)])
  if (!signers.ok || !custody.ok) return null
  const active = signers.value.keys.filter(k => !k.expiresAt || k.expiresAt > now)
  return {
    keys: new Set(active.map(k => k.key)),
    custody: custody.value,
    requestFids: new Map(active.flatMap(k => (k.requestFid ? [[k.key, k.requestFid] as const] : []))),
  }
}
