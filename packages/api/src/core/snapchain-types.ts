import { z } from 'zod'

// Snapchain's HTTP JSON, parsed at the adapter boundary (parse, don't validate). Only the
// fields Warpstack reads are kept; everything else is stripped. Message types Warpstack
// doesn't fold still parse, so a page never fails on a type it ignores.

const Hex = z.string().regex(/^0x[0-9a-fA-F]*$/).transform(s => s.toLowerCase())

export const CastId = z.object({ fid: z.number(), hash: Hex })
export type CastId = z.infer<typeof CastId>

const CastAddBody = z.object({
  text: z.string().default(''),
  embeds: z.array(z.object({ url: z.string().optional(), castId: CastId.optional() })).default([]),
  mentions: z.array(z.number()).default([]),
  mentionsPositions: z.array(z.number()).default([]),
  parentCastId: CastId.nullish(),
  parentUrl: z.string().nullish(),
  type: z.string().optional(),
})

const ReactionBody = z.object({
  type: z.string(),
  targetCastId: CastId.nullish(),
  targetUrl: z.string().nullish(),
})

const UserDataBody = z.object({ type: z.string(), value: z.string() })

const LinkBody = z.object({ type: z.string(), targetFid: z.number().nullish() })

const VerificationBody = z.object({ address: z.string(), protocol: z.string().optional() })

export const MessageData = z.object({
  type: z.string(),
  fid: z.number(),
  timestamp: z.number(),
  castAddBody: CastAddBody.optional(),
  reactionBody: ReactionBody.optional(),
  userDataBody: UserDataBody.optional(),
  linkBody: LinkBody.optional(),
  verificationAddAddressBody: VerificationBody.optional(),
})

export const Message = z.object({ data: MessageData, hash: Hex })
export type Message = z.infer<typeof Message>

const MessageEnvelope = z.object({ message: Message })

export const HubEvent = z.object({
  type: z.string(),
  id: z.number(),
  shardIndex: z.number().optional(),
  blockNumber: z.number().optional(),
  blockConfirmedBody: z.object({ blockNumber: z.number(), timestamp: z.number() }).optional(),
  mergeMessageBody: z.object({ message: Message, deletedMessages: z.array(Message).default([]) }).optional(),
  pruneMessageBody: MessageEnvelope.optional(),
  revokeMessageBody: MessageEnvelope.optional(),
})
export type HubEvent = z.infer<typeof HubEvent>

/** The page envelope only; each event is parsed on its own, so one malformed event can't block a page. */
export const EventsResponse = z.object({ events: z.array(z.unknown()) })

export const MessagesResponse = z.object({
  messages: z.array(Message),
  nextPageToken: z.string().nullish(),
})

export const StorageLimitsResponse = z.object({
  limits: z.array(z.object({ storeType: z.string().optional(), name: z.string().optional(), limit: z.number(), used: z.number() })).nullish(),
  tier_subscriptions: z.array(z.object({ tier_type: z.string(), expires_at: z.number() })).nullish(),
  tierSubscriptions: z.array(z.object({ tierType: z.string(), expiresAt: z.number() })).nullish(),
})

export const UserNameProofResponse = z.object({ fid: z.number(), name: z.string() })

export const InfoResponse = z.object({
  shardInfos: z.array(z.object({ shardId: z.number(), maxHeight: z.number() })),
  version: z.string(),
})

export const SignersResponse = z.object({
  signers: z.array(z.object({
    source: z.string(),
    key: Hex,
    keyType: z.number(),
    addedAt: z.number().nullish(),
    lastUsedAt: z.number().nullish(),
    expiresAt: z.number().nullish(),
    scopes: z.array(z.string()).default([]),
    requestFid: z.number().nullish(),
  })).default([]),
  currentUserNonce: z.number().int().min(0).default(0),
  requesterFidNonces: z.record(z.string(), z.number().int().min(0)).default({}),
})

export const OnChainEventsResponse = z.object({
  events: z.array(z.object({
    type: z.string(),
    blockNumber: z.number(),
    logIndex: z.number().default(0),
    idRegisterEventBody: z.object({ to: Hex, eventType: z.string() }).nullish(),
  })).default([]),
})

/** A submitted message as the node echoes it. */
export const SubmitResponse = z.object({ hash: Hex })

/** Message type names as the HTTP API spells them. */
export const MT = {
  castAdd: 'MESSAGE_TYPE_CAST_ADD',
  castRemove: 'MESSAGE_TYPE_CAST_REMOVE',
  reactionAdd: 'MESSAGE_TYPE_REACTION_ADD',
  reactionRemove: 'MESSAGE_TYPE_REACTION_REMOVE',
  userDataAdd: 'MESSAGE_TYPE_USER_DATA_ADD',
  linkAdd: 'MESSAGE_TYPE_LINK_ADD',
  verificationAdd: 'MESSAGE_TYPE_VERIFICATION_ADD_ETH_ADDRESS',
} as const

/** Message type numbers by HTTP name, for gasless key scopes. */
export const MESSAGE_TYPE_NUMBERS: Record<string, number> = {
  MESSAGE_TYPE_CAST_ADD: 1, MESSAGE_TYPE_CAST_REMOVE: 2, MESSAGE_TYPE_REACTION_ADD: 3, MESSAGE_TYPE_REACTION_REMOVE: 4,
  MESSAGE_TYPE_LINK_ADD: 5, MESSAGE_TYPE_LINK_REMOVE: 6, MESSAGE_TYPE_VERIFICATION_ADD_ETH_ADDRESS: 7,
  MESSAGE_TYPE_VERIFICATION_REMOVE: 8, MESSAGE_TYPE_USER_DATA_ADD: 11, MESSAGE_TYPE_USERNAME_PROOF: 12,
  MESSAGE_TYPE_FRAME_ACTION: 13, MESSAGE_TYPE_LINK_COMPACT_STATE: 14, MESSAGE_TYPE_LEND_STORAGE: 15,
}

export const EV = {
  blockConfirmed: 'HUB_EVENT_TYPE_BLOCK_CONFIRMED',
  merge: 'HUB_EVENT_TYPE_MERGE_MESSAGE',
  prune: 'HUB_EVENT_TYPE_PRUNE_MESSAGE',
  revoke: 'HUB_EVENT_TYPE_REVOKE_MESSAGE',
} as const
