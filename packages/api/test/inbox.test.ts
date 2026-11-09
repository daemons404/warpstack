import type { EventId, Fid } from '@warpstack/protocol'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { HmacMac } from '../src/adapters/hmac.ts'
import { IndexMaintenance } from '../src/adapters/index-maintenance.ts'
import { IndexReader } from '../src/adapters/index-reader.ts'
import { FakeSnapchain } from '../src/adapters/snapchain-fake.ts'
import { foldPage } from '../src/core/fold.ts'
import { notesOf } from '../src/core/inbound.ts'
import type { HubEvent } from '../src/core/snapchain-types.ts'
import type { SyncSql } from '../src/ports.ts'
import { Reads } from '../src/reads.ts'
import { INBOX_DAYS, UserStore, type Delivery } from '../src/user-store.ts'
import { block, castAdd, follow, hash, merge, mention, reaction, remove } from './build.ts'
import { MemorySql } from './sqlite.ts'

// The inbox: ingestion turns every message aimed at a
// member into a step for their user object, which applies it exactly once into grouped rows.

const ME = 7
const T = 1_800_000_000

const memorySync = (): SyncSql => {
  const db = new DatabaseSync(':memory:')
  return {
    all: <R>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...(params as never[])) as R[],
    run: (sql: string, ...params: unknown[]) => { db.prepare(sql).run(...(params as never[])) },
    transaction: <R>(fn: () => R) => {
      db.exec('BEGIN')
      try {
        const r = fn()
        db.exec('COMMIT')
        return r
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  }
}

/** Folds events as ingestion does and hands the member's steps to their store. */
const world = () => {
  const store = new UserStore(memorySync(), ME as Fid)
  let last = 0
  const ingest = (...events: HubEvent[]) => {
    const f = foldPage([...events, block(T + 10_000)], last as EventId)
    last = f.lastEventId
    const mine: Delivery[] = f.ops.own.filter(o => o.fid === ME).map(o => ({ shard: 1, event_id: o.event_id, seq: o.seq, payload: JSON.stringify(o.p) }))
    expect(store.apply(mine)).toEqual({ ok: true })
    return mine
  }
  return { store, ingest }
}

const myCast = { fid: ME, hash: hash(1) }

describe('notifications from messages', () => {
  it('names the recipient of each kind, and never the actor', () => {
    expect(notesOf(reaction({ fid: 9, ts: T, kind: 'like', target: myCast })).map(n => [n.kind, n.to])).toEqual([['like', ME]])
    expect(notesOf(reaction({ fid: 9, ts: T, kind: 'recast', target: myCast })).map(n => [n.kind, n.to])).toEqual([['recast', ME]])
    expect(notesOf(follow({ fid: 9, ts: T, target: ME })).map(n => [n.kind, n.to])).toEqual([['follow', ME]])
    expect(notesOf(castAdd({ fid: 9, ts: T, parent: myCast })).map(n => [n.kind, n.to])).toEqual([['reply', ME]])
    expect(notesOf(mention({ fid: 9, ts: T, mentions: [ME, ME, 8] })).map(n => [n.kind, n.to])).toEqual([['mention', ME], ['mention', 8]])
    // Your own like, reply or follow notifies no one.
    expect(notesOf(reaction({ fid: ME, ts: T, kind: 'like', target: myCast }))).toEqual([])
    expect(notesOf(follow({ fid: ME, ts: T, target: ME }))).toEqual([])
  })

  it('counts a reply that also mentions you twice, as the design says', () => {
    const m = mention({ fid: 9, ts: T, mentions: [ME] })
    const reply = { ...m, data: { ...m.data, castAddBody: { ...m.data.castAddBody!, parentCastId: myCast } } }
    expect(notesOf(reply).map(n => n.kind).sort()).toEqual(['mention', 'reply'])
  })
})

describe('the inbox', () => {
  it('groups likes on one cast, newest actor first, and keeps replies apart', () => {
    const w = world()
    w.ingest(
      merge(reaction({ fid: 9, ts: T, kind: 'like', target: myCast })),
      merge(reaction({ fid: 10, ts: T + 5, kind: 'like', target: myCast })),
      merge(castAdd({ fid: 11, ts: T + 9, parent: myCast })),
    )
    const page = w.store.inbox(null, 25)
    expect(page.map(g => [g.kind, g.count, g.actors])).toEqual([['reply', 1, [11]], ['like', 2, [10, 9]]])
    expect(page[1]!.target).toEqual(myCast)
    expect(w.store.unseen()).toBe(2)
  })

  it('applies a redelivered step once', () => {
    const w = world()
    const steps = w.ingest(merge(reaction({ fid: 9, ts: T, kind: 'like', target: myCast })))
    w.store.apply(steps)
    expect(w.store.inbox(null, 25)[0]!.count).toBe(1)
  })

  it('takes a notification back when the like is undone or the reply deleted', () => {
    const w = world()
    const like = reaction({ fid: 9, ts: T, kind: 'like', target: myCast })
    const other = reaction({ fid: 10, ts: T + 1, kind: 'like', target: myCast })
    const reply = castAdd({ fid: 11, ts: T + 2, parent: myCast })
    w.ingest(merge(like), merge(other), merge(reply))
    w.ingest(remove(like, T + 20), remove(reply, T + 21))
    expect(w.store.inbox(null, 25).map(g => [g.kind, g.count, g.actors])).toEqual([['like', 1, [10]]])
  })

  it('groups follows by day', () => {
    const w = world()
    w.ingest(merge(follow({ fid: 9, ts: T, target: ME })), merge(follow({ fid: 10, ts: T + 60, target: ME })), merge(follow({ fid: 11, ts: T + 3 * 86_400, target: ME })))
    expect(w.store.inbox(null, 25).map(g => [g.kind, g.count])).toEqual([['follow', 1], ['follow', 2]])
  })

  it('marks groups seen, and a group is new again when it gets new activity', () => {
    const w = world()
    w.ingest(merge(reaction({ fid: 9, ts: T, kind: 'like', target: myCast })))
    w.store.markSeen(T)
    expect(w.store.unseen()).toBe(0)
    w.ingest(merge(reaction({ fid: 10, ts: T + 50, kind: 'like', target: myCast })))
    expect(w.store.inbox(null, 25)[0]).toMatchObject({ count: 2, seen: false })
    expect(w.store.unseen()).toBe(1)
  })

  it('pages newest first without skipping or repeating', () => {
    const w = world()
    w.ingest(...Array.from({ length: 30 }, (_, i) => merge(castAdd({ fid: 100 + i, ts: T + i, parent: myCast }))))
    const first = w.store.inbox(null, 25)
    const last = first.at(-1)!
    const second = w.store.inbox({ ts: last.ts, key: last.key }, 25)
    expect(first).toHaveLength(25)
    expect(second).toHaveLength(5)
    expect(new Set([...first, ...second].map(g => g.key)).size).toBe(30)
  })

  it(`keeps ${INBOX_DAYS} days`, () => {
    const w = world()
    w.ingest(merge(castAdd({ fid: 9, ts: T, parent: myCast })))
    w.ingest(merge(castAdd({ fid: 10, ts: T + (INBOX_DAYS + 1) * 86_400, parent: myCast })))
    expect(w.store.inbox(null, 25).map(g => g.actors)).toEqual([[10]])
  })
})

describe('paging notifications', () => {
  it('pages likes, follows and replies through a cursor bound to the member', async () => {
    const w = world()
    // Likes on 20 different casts, a day of follows, and 10 replies: 31 groups.
    w.ingest(...Array.from({ length: 20 }, (_, i) => merge(reaction({ fid: 100 + i, ts: T + i, kind: 'like', target: { fid: ME, hash: hash(1_000 + i) } }))))
    w.ingest(...Array.from({ length: 3 }, (_, i) => merge(follow({ fid: 200 + i, ts: T + 20 + i, target: ME }))))
    w.ingest(...Array.from({ length: 10 }, (_, i) => merge(castAdd({ fid: 300 + i, ts: T + 30 + i, parent: myCast }))))
    const db = new MemorySql()
    const reads = new Reads(new IndexReader(db), new IndexMaintenance(db), new FakeSnapchain(), new HmacMac('k'.repeat(32)), { now: () => (T + 100) as never })
    const page = async (fid: number, cursor?: string) => {
      const before = await reads.notificationsCursor(fid as Fid, cursor)
      if (!before.ok) return before
      const groups = w.store.inbox(before.value, 25 + 1)
      return reads.notifications(fid as Fid, groups.slice(0, 25), groups.length > 25)
    }
    const first = await page(ME)
    if (!first.ok || first.value.next.kind !== 'more') throw new Error('expected a second page')
    const cursor = first.value.next.cursor
    const second = await page(ME, cursor)
    if (!second.ok) throw new Error(JSON.stringify(second.error))
    expect(second.value.next.kind).toBe('end')
    const ids = [...first.value.items, ...second.value.items].map(n => n.id)
    expect(ids).toHaveLength(31)
    expect(new Set(ids).size).toBe(31)
    // Someone else's cursor is refused, not served.
    expect(await page(ME + 1, cursor)).toEqual({ ok: false, error: { kind: 'cursor_invalid' } })
  })
})

describe('filling the inbox from history', () => {
  it('reads likes, recasts and replies on recent casts, mentions and followers, once, as already seen', async () => {
    const snap = new FakeSnapchain()
    const mine = castAdd({ fid: ME, ts: T, hash: hash(500) })
    const target = { fid: ME, hash: mine.hash }
    for (const m of [
      mine,
      reaction({ fid: 9, ts: T + 1, kind: 'like', target }),
      reaction({ fid: 10, ts: T + 2, kind: 'like', target }),
      reaction({ fid: 11, ts: T + 3, kind: 'recast', target }),
      castAdd({ fid: 12, ts: T + 4, parent: target }),
      mention({ fid: 13, ts: T + 5, mentions: [ME] }),
      follow({ fid: 14, ts: T + 6, target: ME }),
      reaction({ fid: ME, ts: T + 7, kind: 'like', target }),
    ]) snap.add(m)
    const db = new MemorySql()
    const reads = new Reads(new IndexReader(db), new IndexMaintenance(db), snap, new HmacMac('k'.repeat(32)), { now: () => T as never })
    const notes = await reads.inboxHistory(ME as Fid)
    expect(notes!.map(n => n.kind).sort()).toEqual(['follow', 'like', 'like', 'mention', 'recast', 'reply'])
    const store = new UserStore(memorySync(), ME as Fid)
    expect(store.inboxFilled()).toBe(false)
    store.fillInbox(notes!)
    expect(store.inboxFilled()).toBe(true)
    expect(store.inbox(null, 25).find(g => g.kind === 'like')).toMatchObject({ count: 2, actors: [10, 9], seen: true })
    expect(store.unseen()).toBe(0)
  })
})
