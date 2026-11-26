import fc from 'fast-check'
import { err, eventIdOf, ok, toFarcasterTime, type EventId, type ShardIndex, type Timestamp } from '@warpstack/protocol'
import { describe, expect, it } from 'vitest'
import { SqlIndexWriter } from '../src/adapters/index-writer.ts'
import { PooledSnapchain } from '../src/adapters/snapchain-pool.ts'
import { API_LIMITS } from '../src/core/limits.ts'
import type { HubEvent, Message } from '../src/core/snapchain-types.ts'
import { ingestTick, type TickMemory } from '../src/ingest.ts'
import type { Snapchain, SqlStatement } from '../src/ports.ts'
import { castAdd, hash, reaction, removeOf, userData } from './build.ts'
import { MemorySql, indexSnapshot } from './sqlite.ts'

// Deterministic simulation of ingestion. Each run generates a chain of Farcaster activity and
// ingests it through `ingestTick` over a two-node pool while nodes go down or lag, pages come
// back short, D1 fails before or after a commit, the Durable Object is evicted and two
// instances tick at once. After the faults stop, the index must equal a model that applies
// the same events once, in order.
//
//   pnpm sim                                   # SIM_RUNS seeds (default 2,000)
//   SIM_SEED=… SIM_PATH=… pnpm sim             # replay a failure fast-check printed

const SHARD = 1 as ShardIndex
const T = 1_793_000_000
const RUNS = Number(process.env.SIM_RUNS ?? 100)

// The chain

type Action =
  | { k: 'cast'; fid: number; parent: number | null }
  | { k: 'like' | 'recast'; fid: number; cast: number }
  | { k: 'unreact'; r: number; how: 'remove' | 'prune' | 'revoke' }
  | { k: 'uncast'; cast: number; how: 'remove' | 'prune' | 'revoke' }
  | { k: 'unlike-old'; cast: number }
  | { k: 'profile'; fid: number; field: 'username' | 'display'; value: string }
  | { k: 'block' }

const fid = fc.integer({ min: 1, max: 4 })
const idx = fc.nat(30)
const how = fc.constantFrom('remove' as const, 'prune' as const, 'revoke' as const)
const action: fc.Arbitrary<Action> = fc.oneof(
  { arbitrary: fc.record({ k: fc.constant('cast' as const), fid, parent: fc.option(idx) }), weight: 4 },
  { arbitrary: fc.record({ k: fc.constantFrom('like' as const, 'recast' as const), fid, cast: idx }), weight: 4 },
  { arbitrary: fc.record({ k: fc.constant('unreact' as const), r: idx, how }), weight: 2 },
  { arbitrary: fc.record({ k: fc.constant('uncast' as const), cast: idx, how }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant('unlike-old' as const), cast: idx }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant('profile' as const), fid, field: fc.constantFrom('username' as const, 'display' as const), value: fc.constantFrom('alice', 'Bob', ' carol ') }), weight: 1 },
  { arbitrary: fc.record({ k: fc.constant('block' as const) }), weight: 3 },
)

type Model = {
  casts: Map<string, { hash: string; fid: number; ts: number; reply: number; parent_hash: string | null; channel: null; text: string; state: number }>
  recasts: Map<string, { hash: string; fid: number; ts: number; target_hash: string; target_fid: number }>
  counts: Map<string, { likes: number; recasts: number; replies: number }>
  users: Map<number, { fid: number; username: string | null; display: string | null; pfp: null }>
}

/**
 * The events a node would emit for `actions`, one block confirmation per block, and the index
 * they imply, applied once and in order. Removals name exactly the message they displace.
 */
const chainOf = (actions: readonly Action[]): { events: HubEvent[]; model: Model } => {
  const model: Model = { casts: new Map(), recasts: new Map(), counts: new Map(), users: new Map() }
  const events: HubEvent[] = []
  const casts: Message[] = []
  const reactions: Message[] = []
  const profiles = new Map<string, Message>()
  let height = 1_000
  let seq = 0
  let n = 0
  const fresh = () => hash(0x5_0000_0000 + ++n)
  const ts = () => T + height

  const confirm = () => {
    events.push({ type: 'HUB_EVENT_TYPE_BLOCK_CONFIRMED', id: eventIdOf(height, 0), blockConfirmedBody: { blockNumber: height, timestamp: toFarcasterTime(ts() as Timestamp) } })
    seq = 1
  }
  const bump = (h: string, d: Partial<{ likes: number; recasts: number; replies: number }>) => {
    const c = model.counts.get(h) ?? { likes: 0, recasts: 0, replies: 0 }
    model.counts.set(h, { likes: c.likes + (d.likes ?? 0), recasts: c.recasts + (d.recasts ?? 0), replies: c.replies + (d.replies ?? 0) })
  }
  const add = (m: Message) => {
    const r = m.data.reactionBody
    if (m.data.castAddBody) {
      const parent = m.data.castAddBody.parentCastId
      model.casts.set(m.hash, { hash: m.hash, fid: m.data.fid, ts: ts(), reply: parent ? 1 : 0, parent_hash: parent?.hash ?? null, channel: null, text: m.data.castAddBody.text, state: 0 })
      if (parent) bump(parent.hash, { replies: 1 })
    } else if (r?.targetCastId) {
      const like = r.type === 'REACTION_TYPE_LIKE'
      bump(r.targetCastId.hash, like ? { likes: 1 } : { recasts: 1 })
      if (!like) model.recasts.set(m.hash, { hash: m.hash, fid: m.data.fid, ts: ts(), target_hash: r.targetCastId.hash, target_fid: r.targetCastId.fid })
    } else if (m.data.userDataBody) {
      const u = model.users.get(m.data.fid) ?? { fid: m.data.fid, username: null, display: null, pfp: null }
      const v = m.data.userDataBody.value.trim()
      if (m.data.userDataBody.type === 'USER_DATA_TYPE_USERNAME') u.username = v.toLowerCase()
      else u.display = v
      model.users.set(m.data.fid, u)
    }
  }
  const subtract = (m: Message) => {
    const r = m.data.reactionBody
    if (m.data.castAddBody) {
      const c = model.casts.get(m.hash)
      if (c && c.state === 0) Object.assign(c, { state: 1, text: '' })
      if (m.data.castAddBody.parentCastId) bump(m.data.castAddBody.parentCastId.hash, { replies: -1 })
    } else if (r?.targetCastId) {
      const like = r.type === 'REACTION_TYPE_LIKE'
      bump(r.targetCastId.hash, like ? { likes: -1 } : { recasts: -1 })
      model.recasts.delete(m.hash)
    }
  }
  const emit = (e: Omit<HubEvent, 'id'>) => events.push({ ...e, id: eventIdOf(height, seq++) })
  const merge = (m: Message, gone: Message[] = []) => {
    emit({ type: 'HUB_EVENT_TYPE_MERGE_MESSAGE', mergeMessageBody: { message: m, deletedMessages: gone } })
    add(m)
    gone.forEach(subtract)
  }
  const drop = (m: Message, way: 'remove' | 'prune' | 'revoke') => {
    if (way === 'remove') return merge(removeOf(m, ts()), [m])
    emit(way === 'prune' ? { type: 'HUB_EVENT_TYPE_PRUNE_MESSAGE', pruneMessageBody: { message: m } } : { type: 'HUB_EVENT_TYPE_REVOKE_MESSAGE', revokeMessageBody: { message: m } })
    subtract(m)
  }
  const pick = <X>(xs: X[], i: number) => (xs.length ? xs[i % xs.length] : undefined)

  confirm()
  for (const a of actions) {
    switch (a.k) {
      case 'block': height++; confirm(); break
      case 'cast': {
        const p = a.parent === null ? undefined : pick(casts, a.parent)
        const m = castAdd({ fid: a.fid, ts: ts(), hash: fresh(), parent: p && { fid: p.data.fid, hash: p.hash } })
        casts.push(m)
        merge(m)
        break
      }
      case 'like': case 'recast': {
        const target = pick(casts, a.cast)
        if (!target) break
        const m = reaction({ fid: a.fid, ts: ts(), kind: a.k, target: { fid: target.data.fid, hash: target.hash }, hash: fresh() })
        // A second reaction of the same kind replaces the first: the node deletes the old one.
        const old = reactions.findIndex(r => r.data.fid === a.fid && r.data.reactionBody?.type === m.data.reactionBody?.type && r.data.reactionBody?.targetCastId?.hash === target.hash)
        const gone = old >= 0 ? reactions.splice(old, 1) : []
        reactions.push(m)
        merge(m, gone)
        break
      }
      case 'unreact': {
        const m = pick(reactions, a.r)
        if (!m) break
        reactions.splice(reactions.indexOf(m), 1)
        drop(m, a.how)
        break
      }
      case 'uncast': {
        const live = casts.filter(c => model.casts.get(c.hash)?.state === 0)
        const m = pick(live, a.cast)
        if (m) drop(m, a.how)
        break
      }
      case 'unlike-old': {
        // A like from before the index's window, removed now: its count goes below zero raw.
        const target = pick(casts, a.cast)
        if (!target) break
        drop(reaction({ fid: 9, ts: T - 100, kind: 'like', target: { fid: target.data.fid, hash: target.hash }, hash: fresh() }), 'remove')
        break
      }
      case 'profile': {
        const key = `${a.fid}:${a.field}`
        const m = userData({ fid: a.fid, ts: ts(), type: a.field === 'username' ? 'USER_DATA_TYPE_USERNAME' : 'USER_DATA_TYPE_DISPLAY', value: a.value })
        const old = profiles.get(key)
        profiles.set(key, m)
        merge(m, old ? [old] : [])
        break
      }
    }
  }
  return { events, model }
}

/** The model in `indexSnapshot`'s shape. */
const snapshotOf = (m: Model) => {
  const byHash = <X extends { hash: string }>(xs: Iterable<X>) => [...xs].sort((a, b) => (a.hash < b.hash ? -1 : 1))
  const clamp = (x: number) => Math.max(0, x)
  return {
    casts: byHash(m.casts.values()),
    recasts: byHash(m.recasts.values()),
    counts: byHash([...m.counts].filter(([, c]) => c.likes || c.recasts || c.replies)
      .map(([h, c]) => ({ hash: h, likes: clamp(c.likes), recasts: clamp(c.recasts), replies: clamp(c.replies) }))),
    users: [...m.users.values()].sort((a, b) => a.fid - b.fid),
  }
}

// The world

type NodeState = 'up' | 'down' | 'lagging'
type Step = { nodes: [NodeState, NodeState]; cap: number; d1: 'ok' | 'fail-before' | 'fail-after'; evict: boolean; concurrent: boolean; advance: number }

const nodeState = fc.constantFrom<NodeState>('up', 'up', 'down', 'lagging')
const step: fc.Arbitrary<Step> = fc.record({
  nodes: fc.tuple(nodeState, nodeState),
  cap: fc.integer({ min: 1, max: 40 }),
  d1: fc.constantFrom('ok' as const, 'ok' as const, 'ok' as const, 'fail-before' as const, 'fail-after' as const),
  evict: fc.integer({ min: 0, max: 6 }).map(x => x === 0),
  concurrent: fc.boolean(),
  advance: fc.integer({ min: 0, max: 90 }),
})

class SimFault extends Error {}

/** D1 that fails the next batch once: before it commits, or after (the commit landed but the reply was lost). */
class FlakySql extends MemorySql {
  fault: Step['d1'] = 'ok'
  override async batch(statements: readonly SqlStatement[]): Promise<void> {
    const f = this.fault
    this.fault = 'ok'
    if (f === 'fail-before') throw new SimFault('D1 failed before the commit')
    await super.batch(statements)
    if (f === 'fail-after') throw new SimFault('D1 failed after the commit')
  }
}

/** A node holding `events`; a lagging one holds only the first half, and every page is capped. */
const simNode = (events: readonly HubEvent[]) => {
  const s = { state: 'up' as NodeState, cap: API_LIMITS.EVENTS_PAGE }
  const api = {
    events: async (_shard: ShardIndex, from: EventId, size: number) => {
      if (s.state === 'down') return err({ kind: 'unavailable' as const, detail: 'sim: node down' })
      const held = s.state === 'lagging' ? events.slice(0, events.length >> 1) : events
      const page = held.filter(e => e.id >= from).slice(0, Math.min(size, s.cap))
      return ok({ events: page, skipped: 0, lastId: (page.at(-1)?.id ?? null) as EventId | null })
    },
    heads: async () => ok(new Map<ShardIndex, number>()),
  } as unknown as Snapchain
  return { s, api }
}

const simulate = async (actions: readonly Action[], steps: readonly Step[]) => {
  const { events, model } = chainOf(actions)
  let now = T + 10_000
  const db = new FlakySql()
  const writer = new SqlIndexWriter(db, () => now * 1_000)
  const nodes = [simNode(events), simNode(events)]
  const deps = {
    snapchain: new PooledSnapchain(nodes.map((n, i) => ({ name: `node${i}`, api: n.api })), () => now * 1_000, new Map()),
    writer,
    clock: { now: () => now as Timestamp },
  }
  let memories: TickMemory[] = [{}, {}]
  const tick = async (memory: TickMemory) => {
    try {
      return await ingestTick(deps, SHARD, { memory })
    } catch (e) {
      if (e instanceof SimFault) return null // the alarm throws and runs again later
      throw e
    }
  }
  let floor = -1
  const cursorNeverMovesBack = async () => {
    const c = await writer.cursor(SHARD)
    if (!c) return
    expect(c.lastEventId).toBeGreaterThanOrEqual(floor)
    floor = c.lastEventId
  }

  for (const s of steps) {
    nodes.forEach((n, i) => Object.assign(n.s, { state: s.nodes[i], cap: s.cap }))
    db.fault = s.d1
    if (s.evict) memories = [{}, {}]
    const results = await Promise.all(s.concurrent ? memories.map(tick) : [tick(memories[0]!)])
    for (const r of results) {
      // Nothing is pruned in the simulation, so the only restart is the first fill.
      if (r?.status === 'restarted') expect(r.reason).toBe('first fill')
    }
    await cursorNeverMovesBack()
    now += s.advance
  }

  // The faults stop, and ingestion catches up within a few ticks. A cursor past trailing
  // confirmations may stay in memory until the next block arrives; replaying them changes nothing.
  nodes.forEach(n => Object.assign(n.s, { state: 'up', cap: API_LIMITS.EVENTS_PAGE }))
  db.fault = 'ok'
  const memory = memories[0]!
  const reached = async () => Math.max((await writer.cursor(SHARD))?.lastEventId ?? -1, memory.pending?.lastEventId ?? -1)
  for (let i = 0; i < 4 && (await reached()) !== events.at(-1)!.id; i++) {
    now += API_LIMITS.QUIET_COMMIT_SECONDS
    await tick(memory)
  }
  await cursorNeverMovesBack()
  expect(await reached()).toBe(events.at(-1)!.id)
  expect(await indexSnapshot(db)).toEqual(snapshotOf(model))
}

describe('ingestion under simulated faults', () => {
  it('ends with the index a single in-order pass would build', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(action, { maxLength: 80 }), fc.array(step, { maxLength: 40 }), simulate),
      {
        numRuns: RUNS,
        ...(process.env.SIM_SEED && { seed: Number(process.env.SIM_SEED) }),
        ...(process.env.SIM_PATH && { path: process.env.SIM_PATH }),
      },
    )
  }, Math.max(30_000, RUNS * 500))
})
