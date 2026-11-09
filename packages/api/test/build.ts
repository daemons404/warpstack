import { toFarcasterTime, type Timestamp } from '@warpstack/protocol'
import type { HubEvent, Message } from '../src/core/snapchain-types.ts'

// Builders for synthetic Snapchain messages and events, in the HTTP API's JSON shape.

let n = 0
export const hash = (seed?: number) => `0x${(seed ?? ++n).toString(16).padStart(40, '0')}`

const fcTime = (ts: number) => toFarcasterTime(ts as Timestamp)

export const castAdd = (o: { fid: number; ts: number; hash?: string; text?: string; parent?: { fid: number; hash: string }; url?: string }): Message => ({
  hash: o.hash ?? hash(),
  data: {
    type: 'MESSAGE_TYPE_CAST_ADD', fid: o.fid, timestamp: fcTime(o.ts),
    castAddBody: {
      text: o.text ?? 'hello', embeds: [], mentions: [], mentionsPositions: [],
      parentCastId: o.parent ?? null, parentUrl: o.url ?? null, type: 'CAST',
    },
  },
})

export const reaction = (o: { fid: number; ts: number; kind: 'like' | 'recast'; target: { fid: number; hash: string }; hash?: string }): Message => ({
  hash: o.hash ?? hash(),
  data: {
    type: 'MESSAGE_TYPE_REACTION_ADD', fid: o.fid, timestamp: fcTime(o.ts),
    reactionBody: { type: o.kind === 'like' ? 'REACTION_TYPE_LIKE' : 'REACTION_TYPE_RECAST', targetCastId: o.target },
  },
})

export const follow = (o: { fid: number; ts: number; target: number }): Message => ({
  hash: hash(),
  data: { type: 'MESSAGE_TYPE_LINK_ADD', fid: o.fid, timestamp: fcTime(o.ts), linkBody: { type: 'follow', targetFid: o.target } },
})

export const mention = (o: { fid: number; ts: number; mentions: number[] }): Message => {
  const m = castAdd({ fid: o.fid, ts: o.ts, text: 'hi ' })
  m.data.castAddBody!.mentions = o.mentions
  m.data.castAddBody!.mentionsPositions = o.mentions.map(() => 3)
  return m
}

export const userData = (o: { fid: number; ts: number; type: string; value: string }): Message => ({
  hash: hash(),
  data: { type: 'MESSAGE_TYPE_USER_DATA_ADD', fid: o.fid, timestamp: fcTime(o.ts), userDataBody: { type: o.type, value: o.value } },
})

const removeOf = (m: Message, ts: number): Message => ({
  hash: hash(),
  data: { type: m.data.type.replace('_ADD', '_REMOVE'), fid: m.data.fid, timestamp: fcTime(ts) },
})

let id = 1_000
export const merge = (message: Message, deleted: Message[] = []): HubEvent =>
  ({ type: 'HUB_EVENT_TYPE_MERGE_MESSAGE', id: ++id, mergeMessageBody: { message, deletedMessages: deleted } })
export const remove = (m: Message, ts: number): HubEvent => merge(removeOf(m, ts), [m])
export const prune = (message: Message): HubEvent => ({ type: 'HUB_EVENT_TYPE_PRUNE_MESSAGE', id: ++id, pruneMessageBody: { message } })
export const revoke = (message: Message): HubEvent => ({ type: 'HUB_EVENT_TYPE_REVOKE_MESSAGE', id: ++id, revokeMessageBody: { message } })
export const block = (ts: number): HubEvent =>
  ({ type: 'HUB_EVENT_TYPE_BLOCK_CONFIRMED', id: ++id, blockConfirmedBody: { blockNumber: id, timestamp: fcTime(ts) } })
