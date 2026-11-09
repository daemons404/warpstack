import { fromFarcasterTime } from '@warpstack/protocol'
import { castRowOf } from './rows.ts'
import { EV, MT, type HubEvent, type Message } from './snapchain-types.ts'

// A member's own messages, as ingestion hands them to their user object:
// what the object needs for `my_casts`, `my_reactions`, `links` and `own_messages`,
// and nothing else. Like the fold, it follows the node's outcome: a merge adds its message and
// removes every message the node says it displaced; a prune or revoke removes one.

export type OwnMessage = {
  hash: string
  fid: number
  ts: number
  kind: 'cast' | 'reaction' | 'link' | 'other'
  cast?: { parent_hash: string | null; channel: string | null; text: string; embeds: string }
  /** 1 like, 2 recast. */
  reaction?: { kind: 1 | 2; target_hash: string }
  /** 1 follow, 2 block. */
  link?: { kind: 1 | 2; target_fid: number }
}

/** One step of a member's history: `add` for a merged message, `remove` for one the node dropped. */
export type OwnEvent = { seq: number; fid: number; op: 'add' | 'remove'; msg: OwnMessage }

const REACTIONS: Record<string, 1 | 2> = { REACTION_TYPE_LIKE: 1, REACTION_TYPE_RECAST: 2 }
const LINKS: Record<string, 1 | 2> = { follow: 1, block: 2 }

export const ownMessageOf = (m: Message): OwnMessage => {
  const base = { hash: m.hash, fid: m.data.fid, ts: fromFarcasterTime(m.data.timestamp) }
  switch (m.data.type) {
    case MT.castAdd: {
      const row = castRowOf(m)
      if (!row) break
      return { ...base, kind: 'cast', cast: { parent_hash: row.parent_hash, channel: row.channel, text: row.text, embeds: row.embeds } }
    }
    case MT.reactionAdd: {
      const kind = REACTIONS[m.data.reactionBody?.type ?? '']
      const target = m.data.reactionBody?.targetCastId
      if (!kind || !target) break
      return { ...base, kind: 'reaction', reaction: { kind, target_hash: target.hash } }
    }
    case MT.linkAdd: {
      const kind = LINKS[m.data.linkBody?.type ?? '']
      const target = m.data.linkBody?.targetFid
      if (!kind || !target) break
      return { ...base, kind: 'link', link: { kind, target_fid: target } }
    }
  }
  return { ...base, kind: 'other' }
}

/** Every own-history step in one event, in order: the merged message, then what it displaced. */
export const ownEventsOf = (e: HubEvent): OwnEvent[] => {
  const out: OwnEvent[] = []
  const push = (op: OwnEvent['op'], m: Message) => out.push({ seq: out.length, fid: m.data.fid, op, msg: ownMessageOf(m) })
  if (e.type === EV.merge && e.mergeMessageBody) {
    push('add', e.mergeMessageBody.message)
    for (const gone of e.mergeMessageBody.deletedMessages) push('remove', gone)
  } else if (e.type === EV.prune && e.pruneMessageBody) {
    push('remove', e.pruneMessageBody.message)
  } else if (e.type === EV.revoke && e.revokeMessageBody) {
    push('remove', e.revokeMessageBody.message)
  }
  return out
}
