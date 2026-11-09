import type { Account, Cast, CastOrTombstone, Channel, Next, Notification, Page, QuotedCast, Rev, StorageUsage, User, UserSummary, ViewerState } from '@warpstack/contract'
import { LIMITS } from '@warpstack/contract'
import { err, ok, type CastHash, type Fid, type Result } from '@warpstack/protocol'
import type { IndexMaintenance, UserFill } from './adapters/index-maintenance.ts'
import type { Coverage, CountedCastRow, IndexReader, Keyset, UserRow } from './adapters/index-reader.ts'
import { channelUrls } from './core/channels.ts'
import { decodeCursor, encodeCursor, type Position } from './core/cursor.ts'
import { API_LIMITS } from './core/limits.ts'
import { castOf, channelOf, embedsOf, quotedOf, userOf, userSummaryOf, type CastContext, type Counts } from './core/present.ts'
import { AVATARS_PER_REQUEST, avatarKey, IMPORT_IMAGES_PER_REQUEST, RETRY_FAILED_SECONDS } from './media.ts'
import { castRowOf, userFieldOf, type CastRow, type ChannelDbRow, type ChannelRow, type UserField } from './core/rows.ts'
import { MT, type Message } from './core/snapchain-types.ts'
import type { InboxGroup } from './user-store.ts'
import { notesOf, type Note } from './core/inbound.ts'
import type { Clock, Mac, MessagePage, Snapchain, UpstreamError } from './ports.ts'

// The read service behind the M1 routes. Reads come from the index first and fall back to
// lazy Snapchain reads outside it. Everything here is the same
// for every viewer: no handler sees a viewer.

export type ReadError =
  | { kind: 'not_found' }
  | { kind: 'cursor_invalid' }
  | { kind: 'upstream'; detail: string }

type R<T> = Promise<Result<T, ReadError>>
type Row = CastRow & Partial<Pick<CountedCastRow, 'state' | 'likes' | 'recasts' | 'replies'>>

const PAGE = LIMITS.pageSize
/** List endpoints that span both data shards return up to `pageSize` per shard. */
const CROSS_SHARD_PAGE = Math.floor(PAGE / 2)
const END: Next = { kind: 'end' }
const HORIZON: Next = { kind: 'horizon' }

const upstream = (e: UpstreamError): Result<never, ReadError> => err({ kind: 'upstream', detail: e.detail })

export class Reads {
  constructor(
    private readonly index: IndexReader,
    private readonly maintenance: IndexMaintenance,
    private readonly snapchain: Snapchain,
    private readonly mac: Mac,
    private readonly clock: Clock,
    /** Called with avatar URLs a response named that aren't stored yet; the app fetches them later. */
    private readonly wantAvatars?: (srcs: string[]) => void,
    /** How long the index keeps casts, which says how far back its lists are complete. */
    private readonly retentionDays: number = API_LIMITS.RETENTION_DAYS,
  ) {}

  /**
   * Asks for the avatars these profiles need, skipping ones stored or recently failed, and
   * names each one's key now as `pending`: the key is fixed by the URL, and the app retries
   * loading it for a few seconds while it's stored, so avatars appear without a refresh.
   */
  private async noteAvatars(rows: Iterable<UserRow | undefined>): Promise<void> {
    await this.noteSquares([...rows].flatMap(r => (r?.pfp ? [{
      src: r.pfp, status: r.pfp_status, ts: r.pfp_ts,
      name: (key: string) => Object.assign(r, { pfp_key: key, pfp_status: 'pending' }),
    }] : [])))
  }

  /** The same for channel images, which are stored as squares like avatars. */
  private async noteChannelImages(rows: Iterable<ChannelDbRow | undefined>, limit = AVATARS_PER_REQUEST): Promise<void> {
    await this.noteSquares([...rows].flatMap(r => (r?.image ? [{
      src: r.image, status: r.image_status, ts: r.image_ts,
      name: (key: string) => Object.assign(r, { image_key: key, image_status: 'pending' }),
    }] : [])), limit)
  }

  /**
   * Asks for square images a response names that aren't stored, skipping ones stored or that
   * failed recently, and names each one fetched now as `pending` under the key fixed by its
   * URL; the app retries loading it while it's stored. At most `limit` per request.
   */
  private async noteSquares(items: { src: string; status?: string | null | undefined; ts?: number | null | undefined; name: (key: string) => void }[], limit = AVATARS_PER_REQUEST): Promise<void> {
    if (!this.wantAvatars) return
    const now = this.clock.now()
    const wanted = new Set<string>()
    const pending: typeof items = []
    for (const it of items) {
      if (it.status === 'ok') continue
      if (it.status === 'failed' && now - (it.ts ?? 0) < RETRY_FAILED_SECONDS) continue
      if (wanted.size < limit) wanted.add(it.src)
      if (wanted.has(it.src)) pending.push(it)
    }
    if (!wanted.size) return
    this.wantAvatars([...wanted])
    const keys = new Map(await Promise.all([...wanted].map(async src => [src, await avatarKey(src)] as const)))
    for (const it of pending) {
      const key = keys.get(it.src)
      if (key) it.name(key)
    }
  }

  /**
   * Channels from the registry (a FID's followed channels), presented with their stored images
   * as the index's channels are.
   */
  async presentChannels(rows: readonly ChannelRow[]): Promise<Channel[]> {
    const media = new Map((await this.index.mediaFor([...new Set(rows.flatMap(r => (r.image ? [r.image] : [])))])).map(m => [m.src, m]))
    const db: ChannelDbRow[] = rows.map(r => {
      const m = r.image ? media.get(r.image) : undefined
      return { ...r, moderators: JSON.stringify(r.moderators), image_key: m?.key ?? null, image_status: m?.status ?? null, image_ts: m?.ts ?? null }
    })
    // An import names many channels at once, so it asks for more than a page does.
    await this.noteChannelImages(db, IMPORT_IMAGES_PER_REQUEST)
    return db.flatMap(r => {
      const c = channelOf(r)
      return c ? [c] : []
    })
  }

  // Pages and cursors

  private coverage(): Promise<Coverage> {
    return this.index.coverage(this.clock.now(), this.retentionDays * 86_400)
  }

  /** The index has every cast and reaction for this time. */
  private covered(cov: Coverage, ts: number) {
    return ts >= cov.from && ts <= cov.asOf
  }

  private async position(scope: string, cursor: string | undefined): Promise<Result<Position | null, ReadError>> {
    if (!cursor) return ok(null)
    const p = await decodeCursor(this.mac, scope, cursor)
    return p.ok ? ok(p.value) : err({ kind: 'cursor_invalid' })
  }

  private async page<T>(items: T[], scope: string, next: Position | Next, cov: Coverage, incomplete = false): Promise<Page<T>> {
    const n: Next = 'kind' in next ? next : { kind: 'more', cursor: (await encodeCursor(this.mac, scope, next)) as never }
    return { items, next: n, rev: cov.rev as Rev, ...(incomplete ? { incompleteBefore: cov.from } : {}) }
  }

  // Hydration

  /**
   * Turns cast rows into full casts: authors and mentioned users, channel keys, counts and
   * quoted casts one level deep. A cast that still fails its schema is dropped from the
   * list and logged, never allowed to fail the whole response.
   */
  private async hydrate(rows: readonly Row[], cov: Coverage, opts: { lazyCounts?: boolean } = {}): Promise<Cast[]> {
    const hidden = await this.index.takenDown(rows.map(r => r.hash))
    const visible = rows.filter(r => !hidden.has(r.hash) && (r.state ?? 0) === 0)
    if (!visible.length) return []

    const quoteRows = await this.quotes(visible)
    const all = [...visible, ...[...quoteRows.values()].filter((r): r is Row => r !== null)]
    const fids = new Set<number>()
    for (const r of all) {
      fids.add(r.fid)
      for (const m of safeJson<{ fid: number }[]>(r.mentions, [])) if (Number.isSafeInteger(m.fid)) fids.add(m.fid)
    }
    const urls = [...new Set(all.map(r => r.channel).filter((u): u is string => !!u))]
    const missingCounts = all.filter(r => r.likes === undefined).map(r => r.hash)
    const [users, channels, indexCounts] = await Promise.all([
      this.users([...fids]),
      this.index.channelsByUrl(urls),
      this.index.countsByHash(missingCounts),
    ])
    const known = new Map(indexCounts.map(c => [c.hash, c]))
    const counts = new Map<string, Counts>()
    for (const r of all) {
      const c = r.likes !== undefined && r.likes !== null ? { likes: r.likes, recasts: r.recasts ?? 0, replies: r.replies ?? 0 } : known.get(r.hash)
      // Counts are exact only for casts inside the index's coverage.
      counts.set(r.hash, { likes: c?.likes ?? 0, recasts: c?.recasts ?? 0, replies: c?.replies ?? 0, exact: this.covered(cov, r.ts) })
    }
    if (opts.lazyCounts) {
      await Promise.all(visible.filter(r => !this.covered(cov, r.ts)).map(async r => { counts.set(r.hash, await this.lazyCounts(r)) }))
    }
    const ctx: CastContext = { users, channelKeys: new Map(channels.map(c => [c.url, c.key])), counts, quotes: new Map() }
    for (const [hash, row] of quoteRows) ctx.quotes.set(hash, row ? quotedOf(row, ctx) : null)
    return keepValid(visible.map(r => [r.hash, castOf(r, ctx)] as const))
  }

  /** Quoted casts by hash: from the index, then a bounded number from Snapchain; `null` when gone or unreadable. */
  private async quotes(rows: readonly Row[]): Promise<Map<string, Row | null>> {
    const refs = new Map<string, { fid: number; hash: string }>()
    for (const r of rows) {
      for (const e of safeJson<{ kind: string; cast?: { fid: number; hash: string } }[]>(r.embeds, [])) {
        if (e.kind === 'cast' && e.cast && /^0x[0-9a-f]{40}$/.test(e.cast.hash)) refs.set(e.cast.hash, e.cast)
      }
    }
    const out = new Map<string, Row | null>()
    if (!refs.size) return out
    const hidden = await this.index.takenDown([...refs.keys()])
    for (const row of await this.index.castsByHash([...refs.keys()])) out.set(row.hash, row.state === 0 && !hidden.has(row.hash) ? row : null)
    const missing = [...refs.values()].filter(r => !out.has(r.hash))
    await Promise.all(missing.map(async (ref, i) => {
      if (i >= API_LIMITS.MAX_QUOTE_READS || hidden.has(ref.hash)) return out.set(ref.hash, null)
      const r = await this.snapchain.castById(ref.fid as Fid, ref.hash as CastHash)
      out.set(ref.hash, r.ok && r.value ? castRowOf(r.value) : null)
    }))
    return out
  }

  /** Bounded upstream counts for one cast older than the index. */
  private async lazyCounts(r: CastRow): Promise<Counts> {
    const cast = { fid: r.fid, hash: r.hash }
    const page = { size: API_LIMITS.LAZY_COUNT_PAGE, reverse: false }
    const [likes, recasts, replies] = await Promise.all([
      this.snapchain.reactionsByCast(cast, 'like', page),
      this.snapchain.reactionsByCast(cast, 'recast', page),
      this.snapchain.castsByParent(cast, page),
    ])
    const n = (p: Result<MessagePage, UpstreamError>) => (p.ok ? p.value.messages.length : 0)
    const exact = [likes, recasts, replies].every(p => p.ok && !p.value.next)
    return { likes: n(likes), recasts: n(recasts), replies: n(replies), exact }
  }

  /** Index profiles, filling missing or partial ones from `userData`, bounded per request. */
  private async users(fids: readonly number[]): Promise<Map<number, UserRow>> {
    const rows = await this.index.usersByFid(fids)
    const byFid = new Map(rows.map(r => [r.fid, r]))
    const missing = fids.filter(f => byFid.get(f)?.complete !== 1).slice(0, API_LIMITS.MAX_FILLS)
    if (missing.length) {
      const fills = (await mapLimit(missing, API_LIMITS.FILL_CONCURRENCY, f => this.fillFromUpstream(f as Fid)))
        .filter((f): f is UserFill => f !== null)
      await this.maintenance.fillUsers(fills)
      for (const r of await this.index.usersByFid(fills.map(f => f.fid))) byFid.set(r.fid, r)
    }
    await this.noteAvatars(byFid.values())
    return byFid
  }

  /** A profile from Snapchain; `null` when the node can't say or the FID has no profile at all. */
  private async fillFromUpstream(fid: Fid, extra = false): Promise<UserFill | null> {
    const data = await this.snapchain.userData(fid)
    if (!data.ok) return null
    const fields: Partial<Record<UserField, string | null>> = {}
    let ts = 0
    for (const m of data.value) {
      const f = userFieldOf(m)
      if (!f) continue
      fields[f.field] = f.value
      ts = Math.max(ts, f.ts)
    }
    // Never write a row for a FID with no profile: anonymous requests would otherwise create one per number.
    if (!Object.keys(fields).length) return null
    const fill: UserFill = { fid, fields, ts }
    if (!extra) return fill
    const [limits, verifications, followers, following] = await Promise.all([
      this.snapchain.storageLimits(fid),
      this.snapchain.verifications(fid),
      this.countLinks(fid, 'followers'),
      this.countLinks(fid, 'following'),
    ])
    if (limits.ok) fill.pro = limits.value.pro
    if (verifications.ok) {
      fill.verified = verifications.value.flatMap(m => {
        const v = m.data.verificationAddAddressBody
        if (!v) return []
        const solana = /solana/i.test(v.protocol ?? '')
        const address = solana ? v.address : v.address.toLowerCase()
        return address.length <= 64 ? [{ address, protocol: solana ? 'solana' as const : 'ethereum' as const }] : []
      })
    }
    if (followers && following) {
      fill.counts = { followers: followers.n, following: following.n, bounded: followers.bounded || following.bounded }
    }
    return fill
  }

  private async countLinks(fid: Fid, kind: 'followers' | 'following'): Promise<{ n: number; bounded: boolean } | null> {
    let token: string | undefined
    let n = 0
    for (let i = 0; i < API_LIMITS.FOLLOW_COUNT_PAGES; i++) {
      const page = { size: API_LIMITS.FOLLOW_COUNT_PAGE_SIZE, reverse: false, token }
      const r = kind === 'followers' ? await this.snapchain.linksByTarget(fid, page) : await this.snapchain.linksByFid(fid, page)
      if (!r.ok) return null
      n += r.value.messages.length
      token = r.value.next
      if (!token) return { n, bounded: false }
    }
    return { n, bounded: true }
  }

  // Routes

  async channelFeed(key: string, cursor?: string): R<Page<Cast>> {
    const scope = `feed.channel:${key}`
    const pos = await this.position(scope, cursor)
    if (!pos.ok) return pos
    if (pos.value && pos.value.k !== 'idx') return err({ kind: 'cursor_invalid' })
    const cov = await this.coverage()
    const [channel] = await this.index.channel(key)
    const before = pos.value?.k === 'idx' ? { ts: pos.value.ts, h: pos.value.h } : null
    // A channel's feed needs only its parent URL, so an unknown key still reads by the URLs
    // clients have used for it (the seeded fallback).
    const rows = await this.index.channelFeed(channelUrls(key, channel?.url), before, PAGE + 1)
    if (!channel && !rows.length && !before) return err({ kind: 'not_found' })
    const items = await this.hydrate(rows.slice(0, PAGE), cov)
    const last = rows[PAGE - 1]
    // Past the index's window, older casts exist but this list doesn't serve them.
    return ok(await this.page(items, scope, rows.length > PAGE && last ? { k: 'idx', ts: last.ts, h: last.hash } : HORIZON, cov, true))
  }

  /**
   * A profile's casts: the index for the window it covers, then Snapchain for everything
   * older. The two never overlap, because the index part reads only `ts >= coverage` and the
   * upstream part only `ts < coverage`. While the index is catching up, the profile reads
   * Snapchain alone, so recent casts the index hasn't reached aren't missing.
   */
  async userFeed(fid: Fid, replies: boolean, cursor?: string): R<Page<Cast>> {
    const scope = `feed.user:${fid}:${replies ? 1 : 0}`
    const pos = await this.position(scope, cursor)
    if (!pos.ok) return pos
    const cov = await this.coverage()
    const lagging = this.clock.now() - cov.asOf > API_LIMITS.INDEX_LAG_TOLERANCE_SECONDS

    let items: Cast[] = []
    let boundary: number
    let token: string | undefined
    if (!pos.value || pos.value.k === 'idx') {
      boundary = lagging ? Number.MAX_SAFE_INTEGER : cov.from
      if (!lagging) {
        const before = pos.value?.k === 'idx' ? { ts: pos.value.ts, h: pos.value.h } : null
        const rows = await this.index.authorFeed(fid, replies, cov.from, before, PAGE + 1)
        items = await this.hydrate(rows.slice(0, PAGE), cov)
        const last = rows[PAGE - 1]
        if (rows.length > PAGE && last) return ok(await this.page(items, scope, { k: 'idx', ts: last.ts, h: last.hash }, cov))
        // A full page that exactly exhausted the index still hands over to Snapchain.
        if (rows.length === PAGE) return ok(await this.page(items, scope, { k: 'up', t: '', b: boundary }, cov))
      }
    } else if (pos.value.k === 'up') {
      boundary = pos.value.b ?? Number.MAX_SAFE_INTEGER
      token = pos.value.t || undefined
    } else {
      return err({ kind: 'cursor_invalid' })
    }

    const rows: CastRow[] = []
    let more = true
    for (let i = 0; i < API_LIMITS.MAX_UPSTREAM_PAGES && items.length + rows.length < PAGE && more; i++) {
      // Ask only for what the page still has room for, so it never exceeds its size and the token stays exact.
      const r = await this.snapchain.castsByFid(fid, { size: PAGE - items.length - rows.length, reverse: true, token })
      if (!r.ok) {
        // Serve what this request already has; the cursor resumes exactly where the failure was.
        if (!items.length && !rows.length) return upstream(r.error)
        const got = [...items, ...(await this.hydrate(rows, cov))]
        return ok(await this.page(got, scope, { k: 'up', t: token ?? '', b: boundary }, cov))
      }
      for (const m of r.value.messages) {
        const row = castRowOf(m)
        if (row && row.ts < boundary && (replies || !row.reply)) rows.push(row)
      }
      token = r.value.next
      more = !!token
    }
    items = [...items, ...(await this.hydrate(rows, cov))]
    return ok(await this.page(items, scope, more && token ? { k: 'up', t: token, b: boundary } : END, cov))
  }

  /**
   * The URL a live cast embeds at `index`, for embed.metadata: the server only ever fetches
   * URLs that real casts embed, never one a caller names.
   */
  async embedUrl(fid: Fid, hash: CastHash, index: number): R<string> {
    const row = await this.castRow(fid, hash)
    if (!row.ok) return row
    if ((row.value.state ?? 0) !== 0 || (await this.index.takenDown([hash])).has(hash)) return err({ kind: 'not_found' })
    const e = embedsOf(row.value)[index]
    return e?.kind === 'url' ? ok(e.url) : err({ kind: 'not_found' })
  }

  /** One cast from the index, tombstones included, or from Snapchain if it's older or the index missed it. */
  private async castRow(fid: Fid, hash: CastHash): R<Row> {
    const [row] = await this.index.castsByHash([hash])
    if (row) return row.fid === fid ? ok(row) : err({ kind: 'not_found' })
    const r = await this.snapchain.castById(fid, hash)
    if (!r.ok) return upstream(r.error)
    const up = r.value && castRowOf(r.value)
    return up ? ok(up) : err({ kind: 'not_found' })
  }

  private async castOrTombstone(row: Row, cov: Coverage): Promise<CastOrTombstone | null> {
    const ref = { fid: row.fid as Fid, hash: row.hash as CastHash }
    if ((await this.index.takenDown([row.hash])).has(row.hash) || row.state === 2) return { state: 'removed', ref }
    if (row.state === 1) return { state: 'deleted', ref }
    const [cast] = await this.hydrate([row], cov, { lazyCounts: true })
    return cast ? { state: 'live', cast } : null
  }

  async cast(fid: Fid, hash: CastHash): R<{ cast: CastOrTombstone; rev: Rev }> {
    const cov = await this.coverage()
    const row = await this.castRow(fid, hash)
    if (!row.ok) return row
    const cast = await this.castOrTombstone(row.value, cov)
    return cast ? ok({ cast, rev: cov.rev as Rev }) : err({ kind: 'not_found' })
  }

  async thread(fid: Fid, hash: CastHash, cursor?: string): R<{ root: CastOrTombstone; ancestors: Cast[]; replies: Page<Cast> }> {
    const scope = `cast.thread:${hash}`
    const pos = await this.position(scope, cursor)
    if (!pos.ok) return pos
    const cov = await this.coverage()
    const rootRow = await this.castRow(fid, hash)
    if (!rootRow.ok) return rootRow

    // Ancestors, nearest first while walking, returned oldest first. Deleted ones are skipped.
    const ancestorRows: Row[] = []
    let parent = rootRow.value.parent_hash && rootRow.value.parent_fid
      ? { fid: rootRow.value.parent_fid, hash: rootRow.value.parent_hash } : null
    for (let hops = 0; parent && hops < LIMITS.ancestors * 2 && ancestorRows.length < LIMITS.ancestors; hops++) {
      const r = await this.castRow(parent.fid as Fid, parent.hash as CastHash)
      if (!r.ok) break
      if ((r.value.state ?? 0) === 0) ancestorRows.unshift(r.value)
      parent = r.value.parent_hash && r.value.parent_fid ? { fid: r.value.parent_fid, hash: r.value.parent_hash } : null
    }

    // Replies come from the index for roots inside its coverage (so are their replies, which
    // are newer), and from Snapchain for older roots.
    let replyRows: Row[]
    let next: Position | Next = END
    if (this.covered(cov, rootRow.value.ts)) {
      if (pos.value && pos.value.k !== 'idx') return err({ kind: 'cursor_invalid' })
      const after: Keyset | null = pos.value?.k === 'idx' ? { ts: pos.value.ts, h: pos.value.h } : null
      const rows = await this.index.replies(hash, after, PAGE + 1)
      replyRows = rows.slice(0, PAGE)
      const last = rows[PAGE - 1]
      if (rows.length > PAGE && last) next = { k: 'idx', ts: last.ts, h: last.hash }
    } else {
      if (pos.value && pos.value.k !== 'up') return err({ kind: 'cursor_invalid' })
      const r = await this.snapchain.castsByParent({ fid, hash }, { size: CROSS_SHARD_PAGE, reverse: false, token: pos.value?.k === 'up' ? pos.value.t : undefined })
      if (!r.ok) return upstream(r.error)
      replyRows = r.value.messages.map(castRowOf).filter((x): x is CastRow => !!x).sort((a, b) => a.ts - b.ts || (a.hash < b.hash ? -1 : 1))
      if (r.value.next) next = { k: 'up', t: r.value.next }
    }

    const [root, ancestors, replies] = await Promise.all([
      this.castOrTombstone(rootRow.value, cov),
      this.hydrate(ancestorRows, cov),
      this.hydrate(replyRows, cov),
    ])
    if (!root) return err({ kind: 'not_found' })
    return ok({ root, ancestors, replies: await this.page(replies, scope, next, cov) })
  }

  /** A page of accounts from an upstream page of messages, hydrated from the index. */
  private async accountPage(scope: string, cursor: string | undefined, read: (token?: string) => Promise<Result<MessagePage, UpstreamError>>,
    fidOf: (m: Message) => number | null | undefined): R<Page<UserSummary>> {
    const pos = await this.position(scope, cursor)
    if (!pos.ok) return pos
    if (pos.value && pos.value.k !== 'up') return err({ kind: 'cursor_invalid' })
    const cov = await this.coverage()
    const r = await read(pos.value?.k === 'up' ? pos.value.t : undefined)
    if (!r.ok) return upstream(r.error)
    const fids = [...new Set(r.value.messages.map(fidOf).filter((f): f is number => Number.isSafeInteger(f) && (f as number) > 0))].slice(0, PAGE)
    const users = await this.users(fids)
    return ok(await this.page(fids.map(f => userSummaryOf(f, users.get(f))), scope, r.value.next ? { k: 'up', t: r.value.next } : END, cov))
  }

  reactors(fid: Fid, hash: CastHash, kind: 'like' | 'recast', cursor?: string): R<Page<UserSummary>> {
    return this.accountPage(`cast.reactors:${hash}:${kind}`, cursor,
      token => this.snapchain.reactionsByCast({ fid, hash }, kind, { size: CROSS_SHARD_PAGE, reverse: true, token }),
      m => m.data.fid)
  }

  followers(fid: Fid, cursor?: string): R<Page<UserSummary>> {
    return this.accountPage(`user.followers:${fid}`, cursor,
      token => this.snapchain.linksByTarget(fid, { size: CROSS_SHARD_PAGE, reverse: true, token }),
      m => m.data.fid)
  }

  following(fid: Fid, cursor?: string): R<Page<UserSummary>> {
    return this.accountPage(`user.following:${fid}`, cursor,
      token => this.snapchain.linksByFid(fid, { size: PAGE, reverse: true, token }),
      m => (m.data.type === MT.linkAdd ? m.data.linkBody?.targetFid : null))
  }

  async user(fid: Fid): R<{ user: User; rev: Rev }> {
    const cov = await this.coverage()
    const [row] = await this.index.usersByFid([fid])
    const stale = !row || row.complete !== 1 || row.verified === null
      || row.counts_ts === null || this.clock.now() - row.counts_ts > API_LIMITS.FOLLOW_COUNT_TTL
    await this.noteAvatars([row])
    if (!stale) return ok({ user: userOf(fid, row), rev: cov.rev as Rev })
    const fill = await this.fillFromUpstream(fid, true)
    if (!fill) {
      if (row) return ok({ user: userOf(fid, row), rev: cov.rev as Rev })
      const probe = await this.snapchain.userData(fid)
      return probe.ok ? err({ kind: 'not_found' }) : upstream(probe.error)
    }
    fill.ts = Math.max(fill.ts, 0)
    await this.maintenance.fillUsers([{ ...fill, countsTs: this.clock.now() }])
    const [filled] = await this.index.usersByFid([fid])
    await this.noteAvatars([filled])
    return ok({ user: userOf(fid, filled), rev: cov.rev as Rev })
  }

  async userByName(username: string): R<{ user: User; rev: Rev }> {
    const [row] = await this.index.userByName(username)
    if (row) return this.user(row.fid as Fid)
    const r = await this.snapchain.fidByUsername(username)
    if (!r.ok) return upstream(r.error)
    return r.value ? this.user(r.value) : err({ kind: 'not_found' })
  }

  async usersBulk(fids: readonly Fid[]): R<{ users: UserSummary[]; rev: Rev }> {
    const cov = await this.coverage()
    const unique = [...new Set(fids)].sort((a, b) => a - b).slice(0, LIMITS.userBulk)
    const users = await this.users(unique)
    return ok({ users: unique.map(f => userSummaryOf(f, users.get(f))), rev: cov.rev as Rev })
  }

  async storage(fid: Fid): R<StorageUsage> {
    const r = await this.snapchain.storageLimits(fid)
    if (!r.ok) return upstream(r.error)
    return ok({ pro: r.value.pro, stores: r.value.stores.slice(0, 16).map(s => ({ type: storeType(s.type), used: Math.max(0, s.used), limit: Math.max(0, s.limit) })) as StorageUsage['stores'] })
  }

  async channel(key: string): R<{ channel: Channel; rev: Rev }> {
    const cov = await this.coverage()
    const [row] = await this.index.channel(key)
    await this.noteChannelImages([row])
    const channel = row && channelOf(row)
    return channel ? ok({ channel, rev: cov.rev as Rev }) : err({ kind: 'not_found' })
  }

  async channels(cursor?: string): R<Page<Channel>> {
    const scope = 'channel.list'
    const pos = await this.position(scope, cursor)
    if (!pos.ok) return pos
    if (pos.value && pos.value.k !== 'rank') return err({ kind: 'cursor_invalid' })
    const cov = await this.coverage()
    const rows = await this.index.channels(pos.value?.k === 'rank' ? pos.value : null, PAGE + 1)
    await this.noteChannelImages(rows.slice(0, PAGE))
    const last = rows[PAGE - 1]
    const items = rows.slice(0, PAGE).map(channelOf).filter((c): c is Channel => c !== null)
    return ok(await this.page(items, scope, rows.length > PAGE && last ? { k: 'rank', n: last.follower_count ?? 0, key: last.key } : END, cov))
  }

  // Account reads (M1.5): keyed by FID and built from public data. The router serves them
  // only for FIDs the deployment accepts writes from, so they can't be used to page the node
  // or fill the follow cache for arbitrary accounts.

  /** Custody, keys and nonces, fresh from the node. */
  async account(fid: Fid): R<Account> {
    const [custody, signers] = await Promise.all([this.snapchain.custodyOf(fid), this.snapchain.signers(fid, [fid])])
    if (!custody.ok) return upstream(custody.error)
    if (!signers.ok) return upstream(signers.error)
    if (!custody.value) return err({ kind: 'not_found' })
    return ok({
      fid,
      custody: custody.value,
      userNonce: signers.value.userNonce,
      appNonce: signers.value.requesterNonces.get(fid) ?? 0,
      keys: signers.value.keys.slice(0, 1_000).map(k => ({
        key: k.key, source: k.source, scopes: k.scopes.slice(0, 32),
        ...(k.requestFid ? { requestFid: k.requestFid } : {}),
        ...(k.addedAt ? { addedAt: k.addedAt } : {}),
        ...(k.lastUsedAt ? { lastUsedAt: k.lastUsedAt } : {}),
        ...(k.expiresAt ? { expiresAt: k.expiresAt } : {}),
      })) as Account['keys'],
    })
  }

  /** The accounts a FID follows: cached for a few minutes, read from the node past that, bounded. */
  private async followingOf(fid: Fid): Promise<Result<{ fids: number[]; complete: boolean }, ReadError>> {
    const now = this.clock.now()
    const cached = await this.index.following(fid)
    if (cached && now - cached.ts < API_LIMITS.FOLLOWING_TTL) return ok(cached)
    const fids = new Set<number>()
    let token: string | undefined
    let complete = false
    for (let i = 0; i * API_LIMITS.FOLLOWING_PAGE < API_LIMITS.MAX_FOLLOWING; i++) {
      const r = await this.snapchain.linksByFid(fid, { size: API_LIMITS.FOLLOWING_PAGE, reverse: true, token })
      if (!r.ok) return cached ? ok(cached) : upstream(r.error)
      for (const m of r.value.messages) {
        const t = m.data.type === MT.linkAdd ? m.data.linkBody?.targetFid : null
        if (typeof t === 'number' && Number.isSafeInteger(t) && t > 0) fids.add(t)
      }
      token = r.value.next
      if (!token) { complete = true; break }
    }
    const list = [...fids].slice(0, API_LIMITS.MAX_FOLLOWING)
    await this.maintenance.putFollowing(fid, list, complete, now)
    return ok({ fids: list, complete })
  }

  /** Top-level casts from the accounts a FID follows, and its own, newest first, inside the index's window. */
  async home(fid: Fid, cursor?: string): R<Page<Cast>> {
    const scope = `account.home:${fid}`
    const pos = await this.position(scope, cursor)
    if (!pos.ok) return pos
    if (pos.value && pos.value.k !== 'idx') return err({ kind: 'cursor_invalid' })
    const following = await this.followingOf(fid)
    if (!following.ok) return following
    const cov = await this.coverage()
    const before = pos.value?.k === 'idx' ? { ts: pos.value.ts, h: pos.value.h } : null
    const from = Math.max(cov.from, this.clock.now() - API_LIMITS.HOME_DAYS * 86_400)
    const rows = await this.index.homeFeed([fid, ...following.value.fids], from, before, PAGE + 1)
    const items = await this.hydrate(rows.slice(0, PAGE), cov)
    const last = rows[PAGE - 1]
    return ok(await this.page(items, scope, rows.length > PAGE && last ? { k: 'idx', ts: last.ts, h: last.hash } : HORIZON, cov, true))
  }

  /**
   * Replies (from the index), mentions (from the node), recasts (from the index) and new
   * followers (from the node), merged newest first. Likes wait for a likes index.
   */
  /**
   * A page of the inbox, as notifications: each group's newest actors as profiles and the cast
   * it's about, read from the index or, outside it, from Snapchain. A cast that can't be read
   * leaves the notification without one rather than dropping it.
   */
  async notifications(fid: Fid, groups: readonly InboxGroup[], more: boolean): R<Page<Notification>> {
    const cov = await this.coverage()
    const refs = new Map(groups.flatMap(g => (g.target ? [[g.target.hash, g.target] as const] : [])))
    const rows = new Map((await this.index.castsByHash([...refs.keys()])).filter(r => r.state === 0).map(r => [r.hash, r as Row]))
    // A few casts outside the index (likes on older casts) are read upstream.
    const missing = [...refs.values()].filter(r => !rows.has(r.hash)).slice(0, API_LIMITS.NOTIFICATION_UPSTREAM_CASTS)
    await mapLimit(missing, API_LIMITS.FILL_CONCURRENCY, async ref => {
      const r = await this.snapchain.castById(ref.fid as Fid, ref.hash as CastHash)
      const row = r.ok && r.value ? castRowOf(r.value) : null
      if (row) rows.set(row.hash, row)
    })
    const casts = new Map<string, Cast>((await this.hydrate([...rows.values()], cov)).map(c => [c.hash, c]))
    const users = await this.users([...new Set(groups.flatMap(g => g.actors))])
    const items = groups.map((g): Notification => ({
      id: g.key,
      kind: g.kind,
      ts: g.ts as Notification['ts'],
      count: g.count as Notification['count'],
      actors: g.actors.slice(0, LIMITS.groupActors).map(f => userSummaryOf(f, users.get(f))),
      ...(g.target && casts.get(g.target.hash) ? { cast: casts.get(g.target.hash)! } : {}),
      seen: g.seen,
    }))
    const last = groups.at(-1)
    return ok(await this.page(items, `notifications:${fid}`, more && last ? { k: 'note', ts: last.ts, key: last.key } : END, cov))
  }

  /**
   * What the inbox would hold had it existed all along, as far as Snapchain can say: likes,
   * recasts and replies on the user's recent casts, mentions and followers. Read once, when the
   * inbox is first opened. Through the same notesOf as ingestion, so history and live events
   * agree; quotes have no upstream lookup and come only from ingestion. Null if the node didn't
   * answer at all.
   */
  async inboxHistory(fid: Fid): Promise<Note[] | null> {
    const size = API_LIMITS.INBOX_FILL_PAGE
    const page = { size, reverse: true }
    const [mine, mentions, followers] = await Promise.all([
      this.snapchain.castsByFid(fid, { size: API_LIMITS.INBOX_FILL_CASTS, reverse: true }),
      this.snapchain.castsByMention(fid, page),
      this.snapchain.linksByTarget(fid, page),
    ])
    if (!mine.ok && !mentions.ok && !followers.ok) return null
    const casts = (mine.ok ? mine.value.messages : []).filter(m => m.data.type === MT.castAdd).slice(0, API_LIMITS.INBOX_FILL_CASTS)
    const pages = await mapLimit(casts, API_LIMITS.INBOX_FILL_CONCURRENCY, async m => {
      const id = { fid: m.data.fid, hash: m.hash }
      const [likes, recasts, replies] = await Promise.all([
        this.snapchain.reactionsByCast(id, 'like', page),
        this.snapchain.reactionsByCast(id, 'recast', page),
        this.snapchain.castsByParent(id, page),
      ])
      return [likes, recasts, replies].flatMap(r => (r.ok ? r.value.messages : []))
    })
    const messages = [...pages.flat(), ...(mentions.ok ? mentions.value.messages : []), ...(followers.ok ? followers.value.messages : [])]
    return messages.flatMap(notesOf).filter(n => n.to === fid)
  }

  /** The inbox position a notifications cursor names. Bound to the FID, like every cursor to its parameters. */
  async notificationsCursor(fid: Fid, cursor: string | undefined): R<{ ts: number; key: string } | null> {
    const p = await this.position(`notifications:${fid}`, cursor)
    if (!p.ok) return p
    if (p.value && p.value.k !== 'note') return err({ kind: 'cursor_invalid' })
    return ok(p.value ? { ts: p.value.ts, key: p.value.key } : null)
  }

  /** A FID's own recent likes and recasts and who it follows, so its screens show them filled in. */
  async viewer(fid: Fid): R<ViewerState> {
    const size = API_LIMITS.VIEWER_REACTIONS
    const [likes, recasts, following] = await Promise.all([
      this.snapchain.reactionsByFid(fid, 'like', { size, reverse: true }),
      this.snapchain.reactionsByFid(fid, 'recast', { size, reverse: true }),
      this.followingOf(fid),
    ])
    if (!likes.ok) return upstream(likes.error)
    if (!recasts.ok) return upstream(recasts.error)
    if (!following.ok) return following
    const targets = (p: MessagePage) => [...new Set(p.messages.map(m => m.data.reactionBody?.targetCastId?.hash)
      .filter((h): h is string => !!h && /^0x[0-9a-f]{40}$/.test(h)))].slice(0, 1_000)
    return ok({
      likes: targets(likes.value) as ViewerState['likes'],
      recasts: targets(recasts.value) as ViewerState['recasts'],
      following: following.value.fids as ViewerState['following'],
      complete: !likes.value.next && !recasts.value.next && following.value.complete,
    })
  }
}

const STORE_TYPES: Record<string, string> = {
  STORE_TYPE_CASTS: 'casts', STORE_TYPE_REACTIONS: 'reactions', STORE_TYPE_LINKS: 'links',
  STORE_TYPE_USER_DATA: 'userData', STORE_TYPE_VERIFICATIONS: 'verifications', STORE_TYPE_USERNAME_PROOFS: 'usernameProofs',
}
const storeType = (t: string) => STORE_TYPES[t] ?? (t.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 64) || 'unknown')

const safeJson = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/** Drops casts that failed their schema, with a log line naming them, instead of failing the page. */
const keepValid = (casts: readonly (readonly [string, Cast | null])[]): Cast[] => {
  const out: Cast[] = []
  for (const [hash, c] of casts) {
    if (c) out.push(c)
    else console.warn(`dropped a cast that failed the contract: ${hash}`)
  }
  return out
}

const mapLimit = async <T, U>(items: readonly T[], limit: number, fn: (t: T) => Promise<U>): Promise<U[]> => {
  const out: U[] = new Array(items.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const at = i++
      out[at] = await fn(items[at] as T)
    }
  }))
  return out
}

export type { QuotedCast }
