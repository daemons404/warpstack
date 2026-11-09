import fc from 'fast-check'
import type { EventId, ShardIndex, Timestamp } from '@warpstack/protocol'
import { describe, expect, it } from 'vitest'
import { SqlIndexWriter } from '../src/adapters/index-writer.ts'
import { foldPage } from '../src/core/fold.ts'
import type { HubEvent } from '../src/core/snapchain-types.ts'
import type { Cursor } from '../src/ports.ts'
import { block, castAdd, hash, merge, prune, reaction, remove, revoke, userData } from './build.ts'
import { recordedPage } from './fixtures.ts'
import { MemorySql } from './sqlite.ts'

const SHARD = 1 as ShardIndex
const T = 1_793_000_000

const start = async (db: MemorySql): Promise<SqlIndexWriter> => {
  const w = new SqlIndexWriter(db, () => 1_793_000_000_000)
  await w.resetCursor({ shard: SHARD, lastEventId: 0 as EventId, lastBlockTs: T as Timestamp })
  return w
}

/** Folds and applies pages in order, as ingestion does. */
const applyAll = async (w: SqlIndexWriter, pages: HubEvent[][]) => {
  for (const events of pages) {
    const cur = (await w.cursor(SHARD))!
    const f = foldPage(events, cur.lastEventId)
    const next: Cursor = { shard: SHARD, lastEventId: f.lastEventId, lastBlockTs: f.lastBlockTs ?? cur.lastBlockTs }
    const r = await w.applyPage(cur, next, f.ops)
    expect(r.ok).toBe(true)
  }
}

const snapshot = async (db: MemorySql) => ({
  casts: await db.all('SELECT hash, fid, ts, reply, parent_hash, channel, text, state FROM casts ORDER BY hash'),
  recasts: await db.all('SELECT * FROM recasts ORDER BY hash'),
  // Counts as readers see them: a missing row and an all-zero row both mean zero. Deltas that
  // cancel within one page write no row; split across pages, they leave a zero row behind.
  counts: await db.all(`SELECT hash, max(0, likes) likes, max(0, recasts) recasts, max(0, replies) replies FROM cast_counts
                        WHERE likes <> 0 OR recasts <> 0 OR replies <> 0 ORDER BY hash`),
  users: await db.all('SELECT fid, username, display, pfp FROM users ORDER BY fid'),
})

describe('the ingestion fold', () => {
  it('adds a cast, counts its replies, likes and recasts, and subtracts exactly what the node removes', async () => {
    const db = new MemorySql()
    const w = await start(db)
    const root = castAdd({ fid: 1, ts: T })
    const reply = castAdd({ fid: 2, ts: T + 1, parent: { fid: 1, hash: root.hash } })
    const like = reaction({ fid: 3, ts: T + 2, kind: 'like', target: { fid: 1, hash: root.hash } })
    const recast = reaction({ fid: 4, ts: T + 3, kind: 'recast', target: { fid: 1, hash: root.hash } })
    await applyAll(w, [[merge(root), merge(reply), merge(like), merge(recast), block(T + 3)]])
    let s = await snapshot(db)
    expect(s.casts).toHaveLength(2)
    expect(s.counts).toContainEqual({ hash: root.hash, likes: 1, recasts: 1, replies: 1 })
    expect(s.recasts).toHaveLength(1)

    // Unlike, un-recast, delete the reply: each names the exact message it displaces.
    await applyAll(w, [[remove(like, T + 4), remove(recast, T + 5), remove(reply, T + 6)]])
    s = await snapshot(db)
    // The removed reply is a tombstone: its row stays, with its text cleared.
    expect(s.casts).toContainEqual(expect.objectContaining({ hash: reply.hash, state: 1, text: '' }))
    expect(s.casts).toContainEqual(expect.objectContaining({ hash: root.hash, state: 0 }))
    expect(s.counts.find(c => (c as { hash: string }).hash === root.hash)).toBeUndefined()
    expect(s.recasts).toHaveLength(0)

    // Re-like counts again.
    await applyAll(w, [[merge(reaction({ fid: 3, ts: T + 7, kind: 'like', target: { fid: 1, hash: root.hash } }))]])
    expect((await snapshot(db)).counts).toContainEqual({ hash: root.hash, likes: 1, recasts: 0, replies: 0 })
  })

  it('removes a pruned or revoked cast, and keeps a reaction that lands before its cast', async () => {
    const db = new MemorySql()
    const w = await start(db)
    const a = castAdd({ fid: 1, ts: T })
    const b = castAdd({ fid: 1, ts: T + 1 })
    const early = reaction({ fid: 9, ts: T + 2, kind: 'like', target: { fid: 5, hash: hash(777) } })
    await applyAll(w, [[merge(a), merge(b), merge(early)]])
    await applyAll(w, [[prune(a), revoke(b)]])
    const s = await snapshot(db)
    expect(s.casts.map(c => (c as { state: number }).state)).toEqual([1, 1])
    expect(s.counts).toContainEqual({ hash: hash(777), likes: 1, recasts: 0, replies: 0 })
  })

  it('never lets a removal from before the window drive a count below zero', async () => {
    const db = new MemorySql()
    const w = await start(db)
    const old = reaction({ fid: 3, ts: T - 100, kind: 'like', target: { fid: 1, hash: hash(555) } })
    await applyAll(w, [[remove(old, T)]])
    expect((await snapshot(db)).counts).toEqual([{ hash: hash(555), likes: 0, recasts: 0, replies: 0 }]) // raw -1, clamped
    await applyAll(w, [[merge(reaction({ fid: 4, ts: T + 1, kind: 'like', target: { fid: 1, hash: hash(555) } })), remove(old, T + 2)]])
    expect((await snapshot(db)).counts).toContainEqual({ hash: hash(555), likes: 0, recasts: 0, replies: 0 })
  })

  it('records channel casts by parent URL and keeps the last profile value', async () => {
    const db = new MemorySql()
    const w = await start(db)
    await applyAll(w, [[
      merge(castAdd({ fid: 1, ts: T, url: 'https://farcaster.xyz/~/channel/base' })),
      merge(userData({ fid: 1, ts: T, type: 'USER_DATA_TYPE_USERNAME', value: 'Alice' })),
      merge(userData({ fid: 1, ts: T + 1, type: 'USER_DATA_TYPE_USERNAME', value: 'alice2' })),
      merge(userData({ fid: 1, ts: T + 1, type: 'USER_DATA_TYPE_DISPLAY', value: 'Alice' })),
    ]])
    const s = await snapshot(db)
    expect(s.casts[0]).toMatchObject({ channel: 'https://farcaster.xyz/~/channel/base', reply: 0 })
    expect(s.users).toEqual([{ fid: 1, username: 'alice2', display: 'Alice', pfp: null }])
  })

  it('applies a page once: a retried or stale page changes nothing', async () => {
    const db = new MemorySql()
    const w = await start(db)
    const page = recordedPage('shard1-page1')
    const cur = (await w.cursor(SHARD))!
    const f = foldPage(page.events, cur.lastEventId)
    const next = { shard: SHARD, lastEventId: f.lastEventId, lastBlockTs: f.lastBlockTs! }
    expect((await w.applyPage(cur, next, f.ops)).ok).toBe(true)
    const once = await snapshot(db)
    const retry = await w.applyPage(cur, next, f.ops)
    expect(retry).toEqual({ ok: false, error: { kind: 'cursor_moved' } })
    expect(await snapshot(db)).toEqual(once)
  })
})

describe('golden replay of recorded pages', () => {
  it('folds two real pages from the public node into a known index', async () => {
    const db = new MemorySql()
    const w = await start(db)
    await applyAll(w, [recordedPage('shard1-page1').events, recordedPage('shard1-page2').events])
    const s = await snapshot(db)
    expect({
      casts: s.casts.length,
      tombstones: s.casts.filter(c => (c as { state: number }).state === 1).length,
      channelCasts: s.casts.filter(c => (c as { channel: string | null }).channel).length,
      replies: s.casts.filter(c => (c as { reply: number }).reply).length,
      recasts: s.recasts.length,
      counted: s.counts.length,
      users: s.users.length,
    }).toMatchSnapshot()
    expect(await w.cursor(SHARD)).toMatchSnapshot()
  })

  it('gives the same index however the pages are split', async () => {
    const events = [...recordedPage('shard1-page1').events, ...recordedPage('shard1-page2').events]
    const whole = new MemorySql()
    await applyAll(await start(whole), [events])
    const expected = await snapshot(whole)

    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.integer({ min: 1, max: events.length - 1 }), { maxLength: 6 }),
      async cuts => {
        const bounds = [0, ...cuts.sort((x, y) => x - y), events.length]
        const pages = bounds.slice(1).map((end, i) => events.slice(bounds[i], end))
        const db = new MemorySql()
        await applyAll(await start(db), pages)
        expect(await snapshot(db)).toEqual(expected)
      },
    ), { numRuns: 12 })
  })
})
