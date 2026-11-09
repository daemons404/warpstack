import { eventIdOf, toFarcasterTime, type EventId, type ShardIndex, type Timestamp } from '@warpstack/protocol'
import { describe, expect, it } from 'vitest'
import { SqlIndexWriter } from '../src/adapters/index-writer.ts'
import { FakeSnapchain } from '../src/adapters/snapchain-fake.ts'
import { API_LIMITS } from '../src/core/limits.ts'
import type { HubEvent } from '../src/core/snapchain-types.ts'
import { ingestTick, type TickMemory } from '../src/ingest.ts'
import { castAdd } from './build.ts'
import { MemorySql } from './sqlite.ts'

const SHARD = 1 as ShardIndex
const T = 1_793_000_000
const clock = { now: () => (T + 100) as Timestamp }

/** One block: its confirmation, then any message events, with real event-ID arithmetic. */
const blockEvents = (height: number, messages: ReturnType<typeof castAdd>[] = []): HubEvent[] => [
  { type: 'HUB_EVENT_TYPE_BLOCK_CONFIRMED', id: eventIdOf(height, 0), blockConfirmedBody: { blockNumber: height, timestamp: toFarcasterTime((T + height - 1_000) as Timestamp) } },
  ...messages.map((m, i) => ({ type: 'HUB_EVENT_TYPE_MERGE_MESSAGE', id: eventIdOf(height, i + 1), mergeMessageBody: { message: m, deletedMessages: [] } })),
]

const setup = (heights: number[], casts: Record<number, ReturnType<typeof castAdd>[]> = {}) => {
  const snap = new FakeSnapchain()
  snap.eventsByShard.set(SHARD, heights.flatMap(h => blockEvents(h, casts[h])))
  const db = new MemorySql()
  const writer = new SqlIndexWriter(db, () => 1_793_000_000_000)
  return { snap, db, writer, deps: { snapchain: snap, writer, clock } }
}

const castCount = async (db: MemorySql) => (await db.all<{ n: number }>('SELECT count(*) n FROM casts'))[0]!.n

describe('ingestTick', () => {
  it('starts a new deployment at the oldest event the node holds, without skipping it', async () => {
    const { deps, writer, db } = setup([1_000, 1_001, 1_002], { 1_000: [castAdd({ fid: 1, ts: T })] })
    const first = await ingestTick(deps, SHARD)
    expect(first).toMatchObject({ status: 'restarted', reason: 'first fill' })
    const cur = await writer.cursor(SHARD)
    expect(cur?.lastEventId).toBe(eventIdOf(1_000) - 1)
    const second = await ingestTick(deps, SHARD)
    expect(second.status).toBe('caught_up')
    expect(await castCount(db)).toBe(1) // the cast in the very first block was indexed
    expect((await writer.cursor(SHARD))?.lastEventId).toBe(eventIdOf(1_002))
  })

  it('does nothing on an empty page and keeps its cursor', async () => {
    const { deps, writer } = setup([1_000])
    await ingestTick(deps, SHARD)
    await ingestTick(deps, SHARD)
    const before = await writer.cursor(SHARD)
    expect(await ingestTick(deps, SHARD)).toMatchObject({ status: 'caught_up', pages: 0 })
    expect(await writer.cursor(SHARD)).toEqual(before)
  })

  it('restarts at what the node holds when events past the cursor were pruned, and moves the coverage mark', async () => {
    const { deps, writer, snap, db } = setup([1_000, 1_001])
    await ingestTick(deps, SHARD)
    await ingestTick(deps, SHARD)
    // The node prunes everything up to block 5,000 while we're down.
    snap.eventsByShard.set(SHARD, [5_000, 5_001].flatMap(h => blockEvents(h)))
    expect(await ingestTick(deps, SHARD)).toMatchObject({ status: 'restarted', reason: 'events pruned past the cursor' })
    const [row] = await db.all<{ covered_since: number }>('SELECT covered_since FROM ingest_cursor')
    expect(row!.covered_since).toBe(T + 5_000 - 1_000)
    expect((await writer.cursor(SHARD))?.lastEventId).toBe(eventIdOf(5_000) - 1)
    expect((await ingestTick(deps, SHARD)).status).toBe('caught_up')
  })

  it('bounds one tick to MAX_PAGES_PER_TICK full pages and reports it is behind', async () => {
    const heights = Array.from({ length: API_LIMITS.EVENTS_PAGE * (API_LIMITS.MAX_PAGES_PER_TICK + 2) }, (_, i) => 1_000 + i)
    const { deps } = setup(heights)
    const memory = {}
    await ingestTick(deps, SHARD, { memory })
    const r = await ingestTick(deps, SHARD, { memory })
    expect(r).toMatchObject({ status: 'behind', pages: API_LIMITS.MAX_PAGES_PER_TICK })
    expect(r.status === 'behind' && r.lastEventId).toBe(eventIdOf(1_000 + API_LIMITS.EVENTS_PAGE * API_LIMITS.MAX_PAGES_PER_TICK - 1))
  })

  it('holds a cursor past confirmation-only pages in memory, and commits it once a minute', async () => {
    let now = T + 100
    const { deps, writer } = setup([1_000, 1_001, 1_002])
    const timed = { ...deps, clock: { now: () => now as Timestamp } }
    const memory: TickMemory = {}
    await ingestTick(timed, SHARD, { memory })
    const start = await writer.cursor(SHARD)
    await ingestTick(timed, SHARD, { memory })
    // Nothing but confirmations: D1 still holds the old cursor; memory holds the new one.
    expect(await writer.cursor(SHARD)).toEqual(start)
    expect(memory.pending).toMatchObject({ lastEventId: eventIdOf(1_002) })
    // A minute later the next tick commits it, even with nothing new to read.
    now += API_LIMITS.QUIET_COMMIT_SECONDS
    ;(deps.snapchain as FakeSnapchain).eventsByShard.set(SHARD, [1_000, 1_001, 1_002, 1_003].flatMap(h => blockEvents(h)))
    await ingestTick(timed, SHARD, { memory })
    expect((await writer.cursor(SHARD))?.lastEventId).toBe(eventIdOf(1_003))
    expect(memory.pending).toBeUndefined()
  })

  it('commits a page with messages at once, even inside the quiet minute', async () => {
    const { deps, writer, db } = setup([1_000, 1_001], { 1_001: [castAdd({ fid: 1, ts: T })] })
    const memory = {}
    await ingestTick(deps, SHARD, { memory })
    await ingestTick(deps, SHARD, { memory })
    expect(await castCount(db)).toBe(1)
    expect((await writer.cursor(SHARD))?.lastEventId).toBe(eventIdOf(1_001, 1))
  })

  it('moves the cursor past an event that fails to parse instead of stopping at it', async () => {
    const { deps, writer, snap, db } = setup([1_000])
    await ingestTick(deps, SHARD)
    await ingestTick(deps, SHARD)
    const good = blockEvents(1_001, [castAdd({ fid: 1, ts: T })])
    const bad = { type: 'HUB_EVENT_TYPE_MERGE_MESSAGE', id: eventIdOf(1_001, 2), mergeMessageBody: { message: { hash: 'nope' } } }
    snap.events = async () => ({ ok: true as const, value: { events: good, skipped: 1, lastId: bad.id as EventId } })
    const r = await ingestTick(deps, SHARD)
    expect(r).toMatchObject({ status: 'caught_up', skipped: 1 })
    expect(await castCount(db)).toBe(1)
    expect((await writer.cursor(SHARD))?.lastEventId).toBe(bad.id)
  })

  it('recovers when another instance moved the cursor first', async () => {
    const { deps, writer } = setup([1_000, 1_001, 1_002], { 1_001: [castAdd({ fid: 1, ts: T })] })
    await ingestTick(deps, SHARD)
    // Simulate a second instance committing the same pages first.
    await ingestTick({ ...deps }, SHARD)
    const r = await ingestTick(deps, SHARD)
    expect(r.status).toBe('caught_up')
    expect((await writer.cursor(SHARD))?.lastEventId).toBe(eventIdOf(1_002))
  })

  it('reports the node as unreachable without touching the cursor', async () => {
    const { deps, writer } = setup([1_000])
    await ingestTick(deps, SHARD)
    const before = await writer.cursor(SHARD)
    const down = { ...deps, snapchain: Object.assign(Object.create(deps.snapchain), { events: async () => ({ ok: false as const, error: { kind: 'unavailable' as const, detail: 'down' } }) }) }
    expect(await ingestTick(down as never, SHARD)).toMatchObject({ status: 'unreachable' })
    expect(await writer.cursor(SHARD)).toEqual(before)
    void (0 as EventId)
  })
})
