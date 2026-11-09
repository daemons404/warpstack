import { Cast, User } from '@warpstack/contract'
import type { CastHash, EventId, Fid, ShardIndex, Timestamp } from '@warpstack/protocol'
import { describe, expect, it } from 'vitest'
import { HmacMac } from '../src/adapters/hmac.ts'
import { IndexMaintenance } from '../src/adapters/index-maintenance.ts'
import { IndexReader } from '../src/adapters/index-reader.ts'
import { SqlIndexWriter } from '../src/adapters/index-writer.ts'
import { FakeSnapchain } from '../src/adapters/snapchain-fake.ts'
import { foldPage } from '../src/core/fold.ts'
import type { HubEvent, Message } from '../src/core/snapchain-types.ts'
import { Reads } from '../src/reads.ts'
import { block, castAdd, hash, merge, reaction, remove, userData } from './build.ts'
import { MemorySql } from './sqlite.ts'

const T = 1_793_000_000
const NOW = T + 5_100
const DAY = 86_400
const URL = 'https://farcaster.xyz/~/channel/base'

const setup = async (opts: { coveredSince?: number; asOf?: number; now?: number } = {}) => {
  const db = new MemorySql()
  const writer = new SqlIndexWriter(db, () => T * 1_000)
  const snap = new FakeSnapchain()
  const now = opts.now ?? NOW
  for (const shard of [1, 2] as ShardIndex[]) {
    await writer.resetCursor({ shard, lastEventId: 0 as EventId, lastBlockTs: (opts.coveredSince ?? T - 1_000) as Timestamp })
  }
  const reads = new Reads(new IndexReader(db), new IndexMaintenance(db), snap, new HmacMac('k'.repeat(32)), { now: () => now as Timestamp })
  /** Folds messages into the index on shard 1, and moves both shards' heads to `asOf`. */
  const ingest = async (events: (Message | HubEvent)[]) => {
    const cur = (await writer.cursor(1 as ShardIndex))!
    const evs = events.map(e => ('type' in e && typeof e.type === 'string' && e.type.startsWith('HUB_')) ? e as HubEvent : merge(e as Message))
    const f = foldPage([...evs, block(opts.asOf ?? NOW - 60)], cur.lastEventId)
    expect((await writer.applyPage(cur, { shard: 1 as ShardIndex, lastEventId: f.lastEventId, lastBlockTs: f.lastBlockTs! }, f.ops)).ok).toBe(true)
    await db.batch([{ sql: 'UPDATE ingest_cursor SET last_block_ts = ?1', params: [opts.asOf ?? NOW - 60] }])
  }
  return { db, snap, reads, ingest, maintenance: new IndexMaintenance(db) }
}

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`)
  return r.value
}
const cursorOf = (p: { next: { kind: string; cursor?: string } }) => (p.next.kind === 'more' ? p.next.cursor : undefined)
const live = (c: { state: string }) => { if (c.state !== 'live') throw new Error(`expected live, got ${c.state}`); return (c as unknown as { cast: Cast }).cast }

describe('channel feeds', () => {
  it('pages 40 casts posted in the same second with no omissions or duplicates, then reaches the horizon', async () => {
    const { reads, ingest, snap } = await setup()
    const casts = Array.from({ length: 40 }, (_, i) => castAdd({ fid: 100 + (i % 3), ts: T, url: URL, text: `c${i}` }))
    snap.add(userData({ fid: 100, ts: T, type: 'USER_DATA_TYPE_USERNAME', value: 'alice' }))
    await ingest(casts)
    const first = unwrap(await reads.channelFeed('base'))
    expect(first.items).toHaveLength(25)
    expect(first.next.kind).toBe('more')
    const second = unwrap(await reads.channelFeed('base', cursorOf(first)))
    expect(second.items).toHaveLength(15)
    // Older casts may exist beyond the index's window; this list doesn't serve them.
    expect(second.next).toEqual({ kind: 'horizon' })
    const seen = [...first.items, ...second.items].map(c => c.hash)
    expect(new Set(seen)).toEqual(new Set(casts.map(c => c.hash)))
    expect(first.items.find(c => c.fid === 100)?.author.username).toBe('alice')
    for (const c of first.items) expect(Cast.safeParse(c).success).toBe(true)
  })

  it('refuses a tampered cursor, and a cursor from another list', async () => {
    const { reads, ingest } = await setup()
    await ingest(Array.from({ length: 30 }, () => castAdd({ fid: 1, ts: T, url: URL })))
    const c = cursorOf(unwrap(await reads.channelFeed('base')))!
    const tampered = c.replace(/^./, x => (x === 'e' ? 'f' : 'e'))
    expect(await reads.channelFeed('base', tampered)).toEqual({ ok: false, error: { kind: 'cursor_invalid' } })
    expect(await reads.channelFeed('memes', c)).toEqual({ ok: false, error: { kind: 'cursor_invalid' } })
  })

  it('says where coverage starts, clamps counts, and reports rev', async () => {
    const { reads, ingest } = await setup({ coveredSince: T - 50 })
    const c = castAdd({ fid: 1, ts: T, url: URL })
    await ingest([c, reaction({ fid: 2, ts: T + 1, kind: 'like', target: { fid: 1, hash: c.hash } })])
    const page = unwrap(await reads.channelFeed('base'))
    expect(page.incompleteBefore).toBe(T - 50)
    expect(page.items[0]?.counts).toEqual({ likes: 1, recasts: 0, replies: 0, exact: true })
    expect(page.rev).toBeGreaterThan(0)
  })

  it('names the channel of a cast posted under the other host', async () => {
    const { reads, ingest } = await setup()
    await ingest([castAdd({ fid: 1, ts: T, url: 'https://warpcast.com/~/channel/base' })])
    const [cast] = unwrap(await reads.channelFeed('base')).items
    expect(cast?.parent).toEqual({ kind: 'channel', key: 'base', url: 'https://warpcast.com/~/channel/base' })
  })

  it('leaves deleted casts out of lists', async () => {
    const { reads, ingest } = await setup()
    const a = castAdd({ fid: 1, ts: T, url: URL })
    const b = castAdd({ fid: 1, ts: T + 1, url: URL })
    await ingest([a, b])
    await ingest([remove(b, T + 2)])
    expect(unwrap(await reads.channelFeed('base')).items.map(c => c.hash)).toEqual([a.hash])
  })
})

describe('hostile profile data', () => {
  it('drops or clamps fields that would fail the contract, so the page still serves', async () => {
    const { reads, ingest } = await setup()
    await ingest([
      userData({ fid: 66, ts: T, type: 'USER_DATA_TYPE_PFP', value: 'https:evil.example' }),
      userData({ fid: 66, ts: T, type: 'USER_DATA_TYPE_URL', value: 'https:/evil.example' }),
      userData({ fid: 66, ts: T, type: 'USER_DATA_TYPE_USERNAME', value: 'Not A Name' }),
      userData({ fid: 66, ts: T, type: 'USER_DATA_TYPE_DISPLAY', value: '😀'.repeat(40) }),
      userData({ fid: 66, ts: T, type: 'USER_DATA_TYPE_BIO', value: 'x'.repeat(2_000) }),
      castAdd({ fid: 66, ts: T, url: URL }),
    ])
    const page = unwrap(await reads.channelFeed('base'))
    const author = page.items[0]!.author
    expect(author.username).toBeUndefined()
    expect(author).not.toHaveProperty('pfp')
    expect(new TextEncoder().encode(author.displayName!).length).toBeLessThanOrEqual(64)
    const { user } = unwrap(await reads.user(66 as Fid))
    expect(User.safeParse(user).success).toBe(true)
    expect(user.url).toBeUndefined()
    expect(new TextEncoder().encode(user.bio!).length).toBeLessThanOrEqual(256)
  })

  it('drops embeds that aren\'t https, and mentions outside the text', async () => {
    const { reads, ingest } = await setup()
    const m = castAdd({ fid: 1, ts: T, url: URL, text: 'hi' })
    m.data.castAddBody!.embeds = [{ url: 'javascript:alert(1)' }, { url: 'http://plain.example' }, { url: 'https://ok.example/a' }]
    m.data.castAddBody!.mentions = [3, 4]
    m.data.castAddBody!.mentionsPositions = [1, 99]
    await ingest([m])
    const [c] = unwrap(await reads.channelFeed('base')).items
    expect(c?.embeds).toEqual([{ kind: 'url', url: 'https://ok.example/a' }])
    expect(c?.mentions.map(x => x.fid)).toEqual([3])
  })
})

describe('profile feeds', () => {
  const profile = async (inIndex: number, older: number) => {
    const env = await setup()
    const recent = Array.from({ length: inIndex }, (_, i) => castAdd({ fid: 7, ts: T + i }))
    const old = Array.from({ length: older }, (_, i) => castAdd({ fid: 7, ts: T - 10_000 - i }))
    await env.ingest(recent)
    // The node holds everything, including what the index already has.
    env.snap.add(...recent, ...old)
    const all: string[] = []
    let cursor: string | undefined
    let pages = 0
    let last
    do {
      last = unwrap(await env.reads.userFeed(7 as Fid, false, cursor))
      all.push(...last.items.map(c => c.hash))
      cursor = cursorOf(last)
      expect(last.items.length).toBeLessThanOrEqual(25)
    } while (cursor && ++pages < 20)
    return { all, last, recent, old }
  }

  it('serves the index first, then older casts from Snapchain without repeating any', async () => {
    const { all, last, recent } = await profile(3, 30)
    expect(all.slice(0, 3)).toEqual(recent.map(c => c.hash).reverse())
    expect(new Set(all).size).toBe(all.length)
    expect(all).toHaveLength(33)
    expect(last.next).toEqual({ kind: 'end' })
  })

  it.each([25, 50])('hands over to Snapchain when the index holds exactly %i casts', async n => {
    const { all } = await profile(n, 10)
    expect(all).toHaveLength(n + 10)
    expect(new Set(all).size).toBe(n + 10)
  })

  it('never repeats a cast the index kept from before a restart', async () => {
    const { reads, ingest, snap, db } = await setup()
    const before = Array.from({ length: 3 }, (_, i) => castAdd({ fid: 7, ts: T - 500 - i }))
    await ingest(before)
    // A gap restart moves coverage past those casts; the index still holds their rows.
    await db.batch([{ sql: 'UPDATE ingest_cursor SET covered_since = ?1', params: [T - 100] }])
    snap.add(...before)
    const page = unwrap(await reads.userFeed(7 as Fid, false))
    expect(page.items.map(c => c.hash)).toEqual(before.map(c => c.hash))
  })

  it('reads Snapchain alone while the index is catching up, so recent casts aren\'t missing', async () => {
    const { reads, snap } = await setup({ asOf: NOW - 3_600 })
    const fresh = castAdd({ fid: 7, ts: NOW - 10 })
    snap.add(fresh)
    expect(unwrap(await reads.userFeed(7 as Fid, false)).items.map(c => c.hash)).toEqual([fresh.hash])
  })

  it('keeps what it already collected when the node fails partway through a page', async () => {
    const { reads, snap } = await setup()
    const replies = Array.from({ length: 30 }, (_, i) => castAdd({ fid: 7, ts: T - 10_000 - i, parent: { fid: 1, hash: hash(1) } }))
    const top = castAdd({ fid: 7, ts: T - 9_000 })
    snap.add(top, ...replies)
    let calls = 0
    const real = snap.castsByFid.bind(snap)
    snap.castsByFid = (async (fid: Fid, page: Parameters<typeof real>[1]) => (++calls === 2 ? { ok: false, error: { kind: 'unavailable', detail: 'down' } } : real(fid, page))) as never
    const first = unwrap(await reads.userFeed(7 as Fid, false))
    expect(first.items.map(c => c.hash)).toEqual([top.hash])
    expect(first.next.kind).toBe('more')
  })

  it('leaves replies out unless asked', async () => {
    const { reads, ingest } = await setup()
    const root = castAdd({ fid: 1, ts: T })
    await ingest([root, castAdd({ fid: 7, ts: T + 1, parent: { fid: 1, hash: root.hash } }), castAdd({ fid: 7, ts: T + 2 })])
    expect(unwrap(await reads.userFeed(7 as Fid, false)).items).toHaveLength(1)
    expect(unwrap(await reads.userFeed(7 as Fid, true)).items).toHaveLength(2)
  })
})

describe('casts and threads', () => {
  it('returns ancestors oldest first and replies oldest first', async () => {
    const { reads, ingest } = await setup()
    const a = castAdd({ fid: 1, ts: T })
    const b = castAdd({ fid: 2, ts: T + 1, parent: { fid: 1, hash: a.hash } })
    const r1 = castAdd({ fid: 3, ts: T + 3, parent: { fid: 2, hash: b.hash } })
    const r2 = castAdd({ fid: 4, ts: T + 2, parent: { fid: 2, hash: b.hash } })
    await ingest([a, b, r1, r2])
    const t = unwrap(await reads.thread(2 as Fid, b.hash as CastHash))
    expect(live(t.root).hash).toBe(b.hash)
    expect(t.ancestors.map(c => c.hash)).toEqual([a.hash])
    expect(t.replies.items.map(c => c.hash)).toEqual([r2.hash, r1.hash])
    expect(t.replies.next).toEqual({ kind: 'end' })
    expect(live(t.root).counts.replies).toBe(2)
  })

  it('says a removed cast is deleted, in cast.get and as a thread root', async () => {
    const { reads, ingest } = await setup()
    const c = castAdd({ fid: 1, ts: T })
    await ingest([c])
    await ingest([remove(c, T + 1)])
    expect(unwrap(await reads.cast(1 as Fid, c.hash as CastHash)).cast).toEqual({ state: 'deleted', ref: { fid: 1, hash: c.hash } })
    expect(unwrap(await reads.thread(1 as Fid, c.hash as CastHash)).root.state).toBe('deleted')
  })

  it('hydrates a quoted cast one level deep, and says null when it can\'t be read', async () => {
    const { reads, ingest } = await setup()
    const quoted = castAdd({ fid: 2, ts: T, text: 'original' })
    const q = castAdd({ fid: 1, ts: T + 1, text: 'look' })
    q.data.castAddBody!.embeds = [{ castId: { fid: 2, hash: quoted.hash } }, { castId: { fid: 9, hash: hash(4242) } }]
    await ingest([quoted, q])
    const c = live(unwrap(await reads.cast(1 as Fid, q.hash as CastHash)).cast)
    const [first, second] = c.embeds
    expect(first && 'cast' in first && first.cast?.text).toBe('original')
    expect(second && 'cast' in second && second.cast).toBeNull()
  })

  it('reads a cast outside the index from Snapchain with bounded counts, and refuses a hash under the wrong FID', async () => {
    const { reads, snap } = await setup()
    const old = castAdd({ fid: 9, ts: T - 100_000, text: 'old' })
    snap.add(old, reaction({ fid: 3, ts: T - 99_000, kind: 'like', target: { fid: 9, hash: old.hash } }))
    const c = live(unwrap(await reads.cast(9 as Fid, old.hash as CastHash)).cast)
    expect(c.text).toBe('old')
    expect(c.counts).toEqual({ likes: 1, recasts: 0, replies: 0, exact: true })
    expect(await reads.cast(8 as Fid, old.hash as CastHash)).toEqual({ ok: false, error: { kind: 'not_found' } })
  })

  it('treats a root older than the retention window as outside the index', async () => {
    const now = T + 40 * DAY
    const { reads, ingest, snap } = await setup({ coveredSince: T - 1_000, asOf: now - 60, now })
    const root = castAdd({ fid: 1, ts: T })
    const reply = castAdd({ fid: 2, ts: T + 5, parent: { fid: 1, hash: root.hash } })
    // The index still has the root; its replies were pruned with the window. Snapchain has both.
    await ingest([root])
    snap.add(root, reply)
    const t = unwrap(await reads.thread(1 as Fid, root.hash as CastHash))
    expect(t.replies.items.map(c => c.hash)).toEqual([reply.hash])
    expect(live(t.root).counts.exact).toBe(true) // re-counted upstream, under the bound
  })
})

describe('users', () => {
  it('writes nothing for a FID with no profile, and says not found', async () => {
    const { reads, db } = await setup()
    expect(await reads.user(424242 as Fid)).toEqual({ ok: false, error: { kind: 'not_found' } })
    expect(await db.all('SELECT * FROM users')).toEqual([])
  })

  it('returns sorted, unique bulk results', async () => {
    const { reads } = await setup()
    const r = unwrap(await reads.usersBulk([5, 3, 5, 1] as Fid[]))
    expect(r.users.map(u => u.fid)).toEqual([1, 3, 5])
  })

  it('never lets a slow fill roll back a newer field from an event', async () => {
    const { reads, ingest, maintenance } = await setup()
    await ingest([userData({ fid: 5, ts: T + 10, type: 'USER_DATA_TYPE_DISPLAY', value: 'New' })])
    await maintenance.fillUsers([{ fid: 5, ts: T, fields: { display: 'Old', bio: 'from the fill' } }])
    const { user } = unwrap(await reads.user(5 as Fid))
    expect(user.displayName).toBe('New')
    expect(user.bio).toBe('from the fill')
  })

  it('maps storage limits', async () => {
    const { reads } = await setup()
    expect(unwrap(await reads.storage(5 as Fid))).toEqual({ pro: false, stores: [{ type: 'casts', used: 3, limit: 100 }] })
  })
})

describe('channels', () => {
  it('lists channels most followed first and skips a malformed registry entry', async () => {
    const { reads, maintenance } = await setup()
    await maintenance.putChannels([
      { key: 'big', url: 'https://farcaster.xyz/~/channel/big', name: 'Big', description: null, image: null, moderators: [], follower_count: 10 },
      { key: 'small', url: 'https://farcaster.xyz/~/channel/small', name: 'Small', description: null, image: null, moderators: [1], follower_count: 1 },
      { key: 'broken', url: '', name: 'Broken', description: null, image: null, moderators: [], follower_count: 5 },
    ], T)
    const page = unwrap(await reads.channels())
    expect(page.items.map(c => c.key)).toEqual(['big', 'small'])
    expect(page.next).toEqual({ kind: 'end' })
  })
})
