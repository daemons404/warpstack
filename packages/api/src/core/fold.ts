import { fromFarcasterTime, type EventId, type Timestamp } from '@warpstack/protocol'
import { inboundOf } from './inbound.ts'
import { ownEventsOf } from './own.ts'
import { castRowOf, emptyOps, userFieldOf, type IndexOps, type UserField } from './rows.ts'
import { EV, MT, type HubEvent, type Message } from './snapchain-types.ts'

// The ingestion fold: a pure function from one event page to the
// index operations it implies. It follows the outcome the node already computed instead of
// re-deriving Farcaster's conflict rules: a merge adds its message, and every message the
// node says is gone (a merge's deletedMessages, a prune, a revoke) subtracts exactly that
// message. Pages apply once, in order, guarded by the cursor, so deltas are safe.

export type FoldResult = {
  ops: IndexOps
  lastEventId: EventId
  /** The newest block timestamp seen, from BLOCK_CONFIRMED events. */
  lastBlockTs: Timestamp | null
  messageEvents: number
}

type Delta = { likes: number; recasts: number; replies: number; ts: number }

export const foldPage = (events: readonly HubEvent[], from: EventId): FoldResult => {
  const ops = emptyOps()
  const counts = new Map<string, Delta>()
  const users = new Map<string, { fid: number; field: UserField; value: string | null; ts: number }>()
  let lastEventId = from
  let lastBlockTs: Timestamp | null = null
  let messageEvents = 0

  const bump = (hash: string, ts: number, d: Partial<Delta>) => {
    const cur = counts.get(hash) ?? { likes: 0, recasts: 0, replies: 0, ts }
    counts.set(hash, {
      likes: cur.likes + (d.likes ?? 0),
      recasts: cur.recasts + (d.recasts ?? 0),
      replies: cur.replies + (d.replies ?? 0),
      ts: Math.min(cur.ts, ts),
    })
  }

  const add = (m: Message) => {
    const ts = fromFarcasterTime(m.data.timestamp)
    switch (m.data.type) {
      case MT.castAdd: {
        const row = castRowOf(m)
        if (!row) return
        ops.castsPut.push(row)
        if (row.parent_hash) bump(row.parent_hash, ts, { replies: 1 })
        return
      }
      case MT.reactionAdd: {
        const target = m.data.reactionBody?.targetCastId
        if (!target) return
        if (m.data.reactionBody?.type === 'REACTION_TYPE_LIKE') bump(target.hash, ts, { likes: 1 })
        if (m.data.reactionBody?.type === 'REACTION_TYPE_RECAST') {
          bump(target.hash, ts, { recasts: 1 })
          ops.recastsPut.push({ hash: m.hash, fid: m.data.fid, ts, target_hash: target.hash, target_fid: target.fid })
        }
        return
      }
      case MT.userDataAdd: {
        const f = userFieldOf(m)
        if (f) users.set(`${m.data.fid}:${f.field}`, { fid: m.data.fid, ...f })
        return
      }
      default:
        return
    }
  }

  const subtract = (m: Message) => {
    const ts = fromFarcasterTime(m.data.timestamp)
    switch (m.data.type) {
      case MT.castAdd: {
        ops.castsDel.push(m.hash)
        const parent = m.data.castAddBody?.parentCastId
        if (parent) bump(parent.hash, ts, { replies: -1 })
        return
      }
      case MT.reactionAdd: {
        const target = m.data.reactionBody?.targetCastId
        if (!target) return
        if (m.data.reactionBody?.type === 'REACTION_TYPE_LIKE') bump(target.hash, ts, { likes: -1 })
        if (m.data.reactionBody?.type === 'REACTION_TYPE_RECAST') {
          bump(target.hash, ts, { recasts: -1 })
          ops.recastsDel.push(m.hash)
        }
        return
      }
      // Removes, displaced profile fields and links have no index effect in M1.
      default:
        return
    }
  }

  for (const e of events) {
    lastEventId = e.id as EventId
    if (e.type === EV.blockConfirmed && e.blockConfirmedBody) {
      lastBlockTs = fromFarcasterTime(e.blockConfirmedBody.timestamp)
      continue
    }
    const own = ownEventsOf(e)
    for (const o of own) ops.own.push({ event_id: e.id, seq: o.seq, fid: o.fid, p: { op: o.op, msg: o.msg } })
    // Notifications aimed at others, numbered after the event's own steps so each key is unique.
    for (const [i, step] of inboundOf(e).entries()) ops.own.push({ event_id: e.id, seq: own.length + i, fid: step.note.to, p: step })
    if (e.type === EV.merge && e.mergeMessageBody) {
      messageEvents++
      add(e.mergeMessageBody.message)
      for (const gone of e.mergeMessageBody.deletedMessages) subtract(gone)
      continue
    }
    if (e.type === EV.prune && e.pruneMessageBody) {
      messageEvents++
      subtract(e.pruneMessageBody.message)
      continue
    }
    if (e.type === EV.revoke && e.revokeMessageBody) {
      messageEvents++
      subtract(e.revokeMessageBody.message)
    }
  }

  // A cast added and removed in the same page is inserted, then tombstoned, exactly as if the
  // two events had fallen into different pages. A recast added and removed leaves nothing.
  const unrecast = new Set(ops.recastsDel)
  ops.recastsPut = ops.recastsPut.filter(r => !unrecast.has(r.hash))
  ops.counts = [...counts].filter(([, d]) => d.likes || d.recasts || d.replies).map(([hash, d]) => ({ hash, ...d }))
  ops.users = [...users.values()]
  return { ops, lastEventId, lastBlockTs, messageEvents }
}
