import { blockHeightOf, eventIdOf, fromFarcasterTime, type EventId, type ShardIndex, type Timestamp } from '@warpstack/protocol'
import { API_LIMITS } from './core/limits.ts'
import { foldPage } from './core/fold.ts'
import { emptyOps } from './core/rows.ts'
import { EV } from './core/snapchain-types.ts'
import type { CastIndexWriter, Clock, Cursor, Snapchain } from './ports.ts'

export type TickResult =
  | { status: 'caught_up' | 'behind'; pages: number; messageEvents: number; skipped: number; lastEventId: EventId; lagSeconds: number }
  | { status: 'unreachable'; detail: string }
  | { status: 'restarted'; reason: string; lastEventId: EventId }
  | { status: 'contended'; detail: string }

/**
 * Ingestion state that lives only in memory, in the Durable Object between alarms. If the
 * object is evicted it's lost, and the next tick starts from D1's cursor, replaying a minute
 * of block confirmations at most, which changes nothing.
 */
export type TickMemory = {
  /** A cursor past confirmation-only pages that hasn't been committed yet. */
  pending?: Cursor | undefined
  /** When the cursor was last committed, in Unix seconds. */
  committedAt?: number | undefined
}

/** How many times a tick re-reads the cursor after another instance moved it, before giving up. */
const MAX_CONTENDED = 3

/**
 * One ingestion tick for one shard: poll `/v1/events` from the
 * cursor, fold each page, and commit it with its cursor in one transaction, up to
 * `MAX_PAGES_PER_TICK` pages while they come back full. A page of block confirmations only
 * moves the cursor in memory and commits at most once a `QUIET_COMMIT_SECONDS`
 * (quiet ticks don't commit): two thirds of events are confirmations.
 */
export const ingestTick = async (
  deps: { snapchain: Snapchain; writer: CastIndexWriter; clock: Clock },
  shard: ShardIndex,
  opts: { backfillHours?: number | undefined; memory?: TickMemory } = {},
): Promise<TickResult> => {
  const { snapchain, writer, clock } = deps
  const memory = opts.memory ?? {}
  const stored = await writer.cursor(shard)

  if (!stored) {
    const start = await startPosition(snapchain, shard, clock, opts.backfillHours)
    if (!start.ok) return { status: 'unreachable', detail: start.detail }
    await writer.resetCursor(start.cursor)
    memory.pending = undefined
    memory.committedAt = clock.now()
    return { status: 'restarted', reason: 'first fill', lastEventId: start.cursor.lastEventId }
  }

  // Resume from an uncommitted position only if it is ahead of what D1 holds.
  let committed = stored
  let cur = memory.pending && memory.pending.lastEventId > stored.lastEventId ? memory.pending : stored
  let pages = 0
  let messageEvents = 0
  let skipped = 0
  let contended = 0

  const commit = async (next: Cursor, ops = emptyOps()): Promise<'ok' | 'moved'> => {
    const applied = await writer.applyPage(committed, next, ops)
    if (!applied.ok) return 'moved'
    committed = next
    memory.pending = undefined
    memory.committedAt = clock.now()
    return 'ok'
  }

  while (pages < API_LIMITS.MAX_PAGES_PER_TICK) {
    const r = await snapchain.events(shard, (cur.lastEventId + 1) as EventId, API_LIMITS.EVENTS_PAGE)
    if (!r.ok) return { status: 'unreachable', detail: r.error.detail }
    const page = r.value
    if (page.lastId === null) break

    // Every block has a confirmation on every shard, so heights are contiguous. A jump past
    // the next height means the node has pruned events we never read: restart at what it
    // still holds, and move the coverage mark so lists say they're incomplete before it.
    const first = page.events[0]
    if (first && cur.lastEventId > 0 && blockHeightOf(first.id as EventId) > blockHeightOf(cur.lastEventId) + 1) {
      const ts = first.blockConfirmedBody ? fromFarcasterTime(first.blockConfirmedBody.timestamp) : clock.now()
      const restart: Cursor = { shard, lastEventId: (first.id - 1) as EventId, lastBlockTs: ts }
      await writer.resetCursor(restart)
      memory.pending = undefined
      memory.committedAt = clock.now()
      return { status: 'restarted', reason: 'events pruned past the cursor', lastEventId: restart.lastEventId }
    }

    const f = foldPage(page.events, cur.lastEventId)
    // The cursor moves past the last raw event, even one that failed to parse.
    const lastEventId = Math.max(f.lastEventId, page.lastId) as EventId
    const next: Cursor = { shard, lastEventId, lastBlockTs: f.lastBlockTs ?? cur.lastBlockTs }
    skipped += page.skipped

    if (f.messageEvents === 0 && clock.now() - (memory.committedAt ?? 0) < API_LIMITS.QUIET_COMMIT_SECONDS) {
      cur = next
      memory.pending = next
    } else if ((await commit(next, f.ops)) === 'moved') {
      // Another instance moved the cursor first; D1's row is the truth.
      if (++contended > MAX_CONTENDED) return { status: 'contended', detail: 'the cursor kept moving under this tick' }
      committed = (await writer.cursor(shard)) ?? committed
      cur = committed
      memory.pending = undefined
      continue
    } else {
      cur = next
    }
    pages++
    messageEvents += f.messageEvents
    if (page.events.length + page.skipped < API_LIMITS.EVENTS_PAGE) break
  }

  const status = pages >= API_LIMITS.MAX_PAGES_PER_TICK ? 'behind' : 'caught_up'
  return { status, pages, messageEvents, skipped, lastEventId: cur.lastEventId, lagSeconds: clock.now() - cur.lastBlockTs }
}

/** Where a new deployment starts: the oldest event the node holds, or a set number of hours back. */
const startPosition = async (snapchain: Snapchain, shard: ShardIndex, clock: Clock, backfillHours?: number):
  Promise<{ ok: true; cursor: Cursor } | { ok: false; detail: string }> => {
  let from = 0 as EventId
  if (backfillHours) {
    const heads = await snapchain.heads()
    if (!heads.ok) return { ok: false, detail: heads.error.detail }
    const head = heads.value.get(shard)
    // About one block a second.
    if (head) from = eventIdOf(Math.max(0, head - Math.round(backfillHours * 3_600)))
  }
  const r = await snapchain.events(shard, from, 1)
  if (!r.ok) return { ok: false, detail: r.error.detail }
  const first = r.value.events[0]
  if (!first) return { ok: false, detail: 'the node returned no events' }
  const ts = (first.type === EV.blockConfirmed && first.blockConfirmedBody
    ? fromFarcasterTime(first.blockConfirmedBody.timestamp) : clock.now()) as Timestamp
  return { ok: true, cursor: { shard, lastEventId: (first.id - 1) as EventId, lastBlockTs: ts } }
}
