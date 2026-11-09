import { fromFarcasterTime } from '@warpstack/protocol'
import { EV, MT, type HubEvent, type Message } from './snapchain-types.ts'

// Notifications as ingestion sees them: every message aimed
// at someone else, as a step for that person's inbox. Ingestion queues the steps only for
// members, in the page's own transaction, and their user objects apply them exactly once.
// Like the fold, it follows the node's outcome: a merged message notifies, and a message the
// node dropped (deleted, undone, pruned or revoked) takes its notifications back.

/** The inbox's kinds, as stored. */
export const NOTE = { reply: 1, mention: 2, quote: 3, follow: 4, like: 5, recast: 6 } as const
export type NoteKind = keyof typeof NOTE

export type Note = {
  /** The source message's hash: with the kind, the inbox row's key. */
  source: string
  kind: NoteKind
  /** Who did it. */
  actor: number
  /** The recipient. */
  to: number
  /** For likes and recasts the recipient's cast; for replies, mentions and quotes the new cast. */
  target: { fid: number; hash: string } | null
  ts: number
}

/** One inbound step: `notify` for a merged message, `unnotify` for one the node dropped. */
export type InboundStep = { op: 'notify' | 'unnotify'; note: Note }

/** The notifications one message causes, at most one per recipient and kind. */
export const notesOf = (m: Message): Note[] => {
  const actor = m.data.fid
  const ts = fromFarcasterTime(m.data.timestamp)
  const out: Note[] = []
  const seen = new Set<string>()
  const push = (kind: NoteKind, to: number | null | undefined, target: Note['target']) => {
    if (!to || to === actor || seen.has(`${kind}:${to}`)) return
    seen.add(`${kind}:${to}`)
    out.push({ source: m.hash, kind, actor, to, target, ts })
  }
  switch (m.data.type) {
    case MT.castAdd: {
      const body = m.data.castAddBody
      if (!body) break
      const self = { fid: actor, hash: m.hash }
      push('reply', body.parentCastId?.fid, self)
      for (const fid of body.mentions.slice(0, 10)) push('mention', fid, self)
      for (const e of body.embeds) if (e.castId) push('quote', e.castId.fid, self)
      break
    }
    case MT.reactionAdd: {
      const t = m.data.reactionBody?.targetCastId
      const kind = m.data.reactionBody?.type === 'REACTION_TYPE_LIKE' ? 'like' : m.data.reactionBody?.type === 'REACTION_TYPE_RECAST' ? 'recast' : null
      if (kind && t) push(kind, t.fid, { fid: t.fid, hash: t.hash })
      break
    }
    case MT.linkAdd:
      if (m.data.linkBody?.type === 'follow') push('follow', m.data.linkBody.targetFid, null)
      break
  }
  return out
}

/** Every inbound step in one event, in order: the merged message, then what it displaced. */
export const inboundOf = (e: HubEvent): InboundStep[] => {
  const out: InboundStep[] = []
  const add = (op: InboundStep['op'], m: Message) => {
    for (const note of notesOf(m)) out.push({ op, note })
  }
  if (e.type === EV.merge && e.mergeMessageBody) {
    add('notify', e.mergeMessageBody.message)
    for (const gone of e.mergeMessageBody.deletedMessages) add('unnotify', gone)
  } else if (e.type === EV.prune && e.pruneMessageBody) {
    add('unnotify', e.pruneMessageBody.message)
  } else if (e.type === EV.revoke && e.revokeMessageBody) {
    add('unnotify', e.revokeMessageBody.message)
  }
  return out
}
