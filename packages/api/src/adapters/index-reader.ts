import type { ChannelDbRow, CountedCastRow, RecastRow, UserRow } from '../core/rows.ts'
import type { Sql } from '../ports.ts'

/** Profiles with their stored avatar, if the media store has one for the profile's current URL. */
const USERS = `SELECT users.*, m.key AS pfp_key, m.status AS pfp_status, m.ts AS pfp_ts
  FROM users LEFT JOIN media_sources m ON m.src = users.pfp AND m.kind = 'avatar'`

/** Channels with their stored image (square, like an avatar), if the media store has one. */
const CHANNELS = `SELECT channels.*, m.key AS image_key, m.status AS image_status, m.ts AS image_ts
  FROM channels LEFT JOIN media_sources m ON m.src = channels.image AND m.kind = 'avatar'`

export type { ChannelDbRow, CountedCastRow, UserRow } from '../core/rows.ts'

// The cast index's read side. Every list query is a range read over an index that names
// the full pagination order, with both cursor fields in the keyset predicate so casts that
// share a second are never skipped. Lists read live casts only; tombstones come back only
// from `castsByHash`, which is how cast.get and threads say a cast is gone.

export type Keyset = { ts: number; h: string }

/** What the index covers: complete for `[from, asOf]` on every shard, and `rev` at the read. */
export type Coverage = { rev: number; from: number; asOf: number }

const COUNTED = `SELECT c.*, max(0, cc.likes) AS likes, max(0, cc.recasts) AS recasts, max(0, cc.replies) AS replies
                 FROM casts c LEFT JOIN cast_counts cc ON cc.hash = c.hash`

export class IndexReader {
  constructor(private readonly db: Sql) {}

  /**
   * Read before the data a response carries, so a response never claims a newer revision
   * than its data. Coverage starts at the later of the restart mark and the retention edge,
   * since the daily prune deletes everything older than the window.
   */
  async coverage(now: number, retentionSeconds: number): Promise<Coverage> {
    const [meta] = await this.db.all<{ rev: number }>('SELECT rev FROM index_meta WHERE k = 1')
    const rows = await this.db.all<{ last_block_ts: number; covered_since: number }>(
      'SELECT last_block_ts, covered_since FROM ingest_cursor')
    const rev = meta?.rev ?? 0
    // Nothing ingested yet: the index covers nothing, so everything reads upstream.
    if (rows.length < 2) return { rev, from: now, asOf: now - 1 }
    return {
      rev,
      from: Math.max(...rows.map(r => r.covered_since), now - retentionSeconds),
      asOf: Math.min(...rows.map(r => r.last_block_ts)),
    }
  }

  castsByHash(hashes: readonly string[]): Promise<CountedCastRow[]> {
    if (!hashes.length) return Promise.resolve([])
    return this.db.all(`${COUNTED} WHERE c.hash IN (SELECT value FROM json_each(?1))`, [JSON.stringify(hashes)])
  }

  countsByHash(hashes: readonly string[]): Promise<{ hash: string; likes: number; recasts: number; replies: number }[]> {
    if (!hashes.length) return Promise.resolve([])
    return this.db.all(
      `SELECT hash, max(0, likes) AS likes, max(0, recasts) AS recasts, max(0, replies) AS replies
       FROM cast_counts WHERE hash IN (SELECT value FROM json_each(?1))`, [JSON.stringify(hashes)])
  }

  /**
   * Top-level casts carrying any of the channel's parent URLs, newest first. One range read
   * per URL, merged here: `channel IN (…) ORDER BY ts` would read and sort the whole channel.
   */
  async channelFeed(urls: readonly string[], before: Keyset | null, limit: number): Promise<CountedCastRow[]> {
    const lists = await Promise.all(urls.map(url => this.db.all<CountedCastRow>(
      `${COUNTED} WHERE c.channel = ?1 AND c.state = 0
         AND (?2 IS NULL OR c.ts < ?2 OR (c.ts = ?2 AND c.hash < ?3))
       ORDER BY c.ts DESC, c.hash DESC LIMIT ?4`,
      [url, before?.ts ?? null, before?.h ?? '', limit])))
    return lists.flat().sort((a, b) => b.ts - a.ts || (a.hash < b.hash ? 1 : a.hash > b.hash ? -1 : 0)).slice(0, limit)
  }

  /** One account's live casts at or after `from`, newest first; replies only when asked. */
  authorFeed(fid: number, replies: boolean, from: number, before: Keyset | null, limit: number): Promise<CountedCastRow[]> {
    return this.db.all(
      `${COUNTED} WHERE c.fid = ?1 AND (?2 = 1 OR c.reply = 0) AND c.state = 0 AND c.ts >= ?3
         AND (?4 IS NULL OR c.ts < ?4 OR (c.ts = ?4 AND c.hash < ?5))
       ORDER BY c.ts DESC, c.hash DESC LIMIT ?6`,
      [fid, replies ? 1 : 0, from, before?.ts ?? null, before?.h ?? '', limit])
  }

  /**
   * Top-level casts by any of these accounts at or after `from`, newest first: the home feed.
   * The author index serves each account's range; the merge and limit happen in SQLite.
   */
  homeFeed(fids: readonly number[], from: number, before: Keyset | null, limit: number): Promise<CountedCastRow[]> {
    if (!fids.length) return Promise.resolve([])
    return this.db.all(
      `${COUNTED} WHERE c.fid IN (SELECT value FROM json_each(?1)) AND c.reply = 0 AND c.state = 0 AND c.ts >= ?2
         AND (?3 IS NULL OR c.ts < ?3 OR (c.ts = ?3 AND c.hash < ?4))
       ORDER BY c.ts DESC, c.hash DESC LIMIT ?5`,
      [JSON.stringify(fids), from, before?.ts ?? null, before?.h ?? '', limit])
  }

  /** Recent live replies to any of an account's casts, by others, newest first. */
  repliesTo(fid: number, limit: number): Promise<CountedCastRow[]> {
    return this.db.all(
      `${COUNTED} WHERE c.parent_fid = ?1 AND c.fid != ?1 AND c.state = 0 ORDER BY c.ts DESC LIMIT ?2`, [fid, limit])
  }

  /** Recent recasts of an account's casts, by others, newest first. */
  recastsOf(fid: number, limit: number): Promise<RecastRow[]> {
    return this.db.all('SELECT * FROM recasts WHERE target_fid = ?1 AND fid != ?1 ORDER BY ts DESC LIMIT ?2', [fid, limit])
  }

  async following(fid: number): Promise<{ fids: number[]; complete: boolean; ts: number } | null> {
    const [row] = await this.db.all<{ fids: string; complete: number; ts: number }>('SELECT fids, complete, ts FROM following_cache WHERE fid = ?1', [fid])
    if (!row) return null
    try {
      const fids = JSON.parse(row.fids) as unknown
      return Array.isArray(fids) ? { fids: fids.filter((f): f is number => Number.isSafeInteger(f) && f > 0), complete: row.complete === 1, ts: row.ts } : null
    } catch {
      return null
    }
  }

  /** Live replies to one cast, oldest first, so a thread reads top to bottom. */
  replies(parentHash: string, after: Keyset | null, limit: number): Promise<CountedCastRow[]> {
    return this.db.all(
      `${COUNTED} WHERE c.parent_hash = ?1 AND c.state = 0
         AND (?2 IS NULL OR c.ts > ?2 OR (c.ts = ?2 AND c.hash > ?3))
       ORDER BY c.ts ASC, c.hash ASC LIMIT ?4`,
      [parentHash, after?.ts ?? null, after?.h ?? '', limit])
  }

  usersByFid(fids: readonly number[]): Promise<UserRow[]> {
    if (!fids.length) return Promise.resolve([])
    return this.db.all(`${USERS} WHERE users.fid IN (SELECT value FROM json_each(?1))`, [JSON.stringify(fids)])
  }

  /** The newest row with this username: after an fname transfer the old holder's row can linger. */
  userByName(username: string): Promise<UserRow[]> {
    return this.db.all(`${USERS} WHERE users.username = ?1 ORDER BY users.updated_ts DESC LIMIT 1`, [username])
  }

  channel(key: string): Promise<ChannelDbRow[]> {
    return this.db.all(`${CHANNELS} WHERE channels.key = ?1`, [key])
  }

  channelsByUrl(urls: readonly string[]): Promise<ChannelDbRow[]> {
    if (!urls.length) return Promise.resolve([])
    return this.db.all('SELECT * FROM channels WHERE url IN (SELECT value FROM json_each(?1))', [JSON.stringify(urls)])
  }

  /** Channels, most followed first. */
  channels(after: { n: number; key: string } | null, limit: number): Promise<ChannelDbRow[]> {
    return this.db.all(
      `${CHANNELS}
       WHERE (?1 IS NULL OR coalesce(channels.follower_count, 0) < ?1 OR (coalesce(channels.follower_count, 0) = ?1 AND channels.key > ?2))
       ORDER BY coalesce(channels.follower_count, 0) DESC, channels.key ASC LIMIT ?3`,
      [after?.n ?? null, after?.key ?? '', limit])
  }

  /** What the media store holds for these remote image URLs, as squares. */
  mediaFor(srcs: readonly string[]): Promise<{ src: string; key: string | null; status: string; ts: number }[]> {
    if (!srcs.length) return Promise.resolve([])
    return this.db.all(`SELECT src, key, status, ts FROM media_sources WHERE kind = 'avatar' AND src IN (SELECT value FROM json_each(?1))`, [JSON.stringify(srcs)])
  }

  async channelCount(): Promise<number> {
    const [row] = await this.db.all<{ n: number }>('SELECT count(*) AS n FROM channels')
    return row?.n ?? 0
  }

  async takenDown(keys: readonly string[]): Promise<Set<string>> {
    if (!keys.length) return new Set()
    const rows = await this.db.all<{ key: string }>('SELECT key FROM takedowns WHERE key IN (SELECT value FROM json_each(?1))', [JSON.stringify(keys)])
    return new Set(rows.map(r => r.key))
  }
}
