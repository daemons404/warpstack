import { z } from 'zod'
import {
  Address, CastHash, ChannelKey, Count, Fid, Fname, HttpsUrl, MediaKey, OriginUrl, ParentUrl, Rev, SemVer, Timestamp,
  openEnum, openUnion, utf8,
} from './codecs.ts'
import { LIMITS } from './limits.ts'

// Entities: Zod schemas in the wire dialect, registered by
// name so OpenAPI gets named components and CI walks can find them.

export const registry = z.registry<{ id: string; viewerScoped?: boolean }>()
const named = <T extends z.ZodType>(id: string, schema: T, opts: { viewerScoped?: boolean } = {}): T => {
  ;(schema as unknown as z.ZodType).register(registry, { id, ...opts })
  return schema
}

/** Every cast reference carries its FID, so any cast can be read upstream. */
export const CastRef = named('CastRef', z.object({ fid: Fid, hash: CastHash }))
export type CastRef = z.infer<typeof CastRef>

export const UserSummary = named('UserSummary', z.object({
  fid: Fid,
  username: Fname.optional(),
  displayName: utf8(64).optional(),
  pfp: MediaKey.optional(),
  pro: z.boolean(),
}))
export type UserSummary = z.infer<typeof UserSummary>

/** A mention at a UTF-8 byte offset in the cast's text. */
export const Mention = z.object({ fid: Fid, pos: Count, username: Fname.optional() })

export const Counts = z.object({
  likes: Count,
  recasts: Count,
  replies: Count,
  /** False when the count is a lower bound: the cast is older than the index's coverage, or a bounded read stopped. */
  exact: z.boolean(),
})

const Parent = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cast'), ref: CastRef }),
  z.object({ kind: z.literal('channel'), key: ChannelKey, url: ParentUrl }),
  z.object({ kind: z.literal('url'), url: HttpsUrl }),
])

const castFields = {
  fid: Fid,
  hash: CastHash,
  ts: Timestamp,
  /** ≤ 320, 321–1,024, 1,025–10,000 bytes (Pro only). */
  type: openEnum(['cast', 'long', 'tenK']),
  text: utf8(LIMITS.castBytes.tenK),
  mentions: z.array(Mention).max(LIMITS.mentions),
  parent: Parent.optional(),
  counts: Counts,
  /** A snapshot; the client merges it into users by FID and `rev`. */
  author: UserSummary,
}

/** A quoted cast's own embeds: references only, one level deep. */
export const EmbedRef = openUnion([
  z.object({ kind: z.literal('url'), url: HttpsUrl }),
  z.object({ kind: z.literal('cast'), ref: CastRef }),
])

export const QuotedCast = named('QuotedCast', z.object({ ...castFields, embeds: z.array(EmbedRef).max(LIMITS.embeds) }))
export type QuotedCast = z.infer<typeof QuotedCast>

export const Embed = openUnion([
  z.object({ kind: z.literal('url'), url: HttpsUrl }),
  /** `cast` is null when the quoted cast is deleted or can't be read. */
  z.object({ kind: z.literal('cast'), ref: CastRef, cast: QuotedCast.nullable() }),
])
export type Embed = z.infer<typeof Embed>

/**
 * What a cast's URL embed is, read once by the server (embed.metadata). Images are MediaKeys
 * on the media origin, re-encoded by the server; nothing here is a remote URL to load.
 * `domain` is always the embedded URL's own host, never what the page says about itself.
 */
export const EmbedMetadata = named('EmbedMetadata', openUnion([
  z.object({ kind: z.literal('image'), media: MediaKey, width: z.number().int().min(1).max(10_000), height: z.number().int().min(1).max(10_000) }),
  z.object({
    kind: z.literal('link'),
    domain: z.string().min(1).max(253),
    title: utf8(800).optional(),
    description: utf8(1_600).optional(),
    site: utf8(320).optional(),
    image: z.object({ media: MediaKey, width: z.number().int().min(1).max(10_000), height: z.number().int().min(1).max(10_000) }).optional(),
  }),
  z.object({ kind: z.literal('unknown'), domain: z.string().min(1).max(253) }),
]))
export type EmbedMetadata = z.infer<typeof EmbedMetadata>

export const Cast = named('Cast', z.object({ ...castFields, embeds: z.array(Embed).max(LIMITS.embeds) }))
export type Cast = z.infer<typeof Cast>

/** Only this says a cast is gone; a cast missing from a page proves nothing. */
export const CastOrTombstone = named('CastOrTombstone', z.discriminatedUnion('state', [
  z.object({ state: z.literal('live'), cast: Cast }),
  /** A CastRemove, prune or revoke was seen. */
  z.object({ state: z.literal('deleted'), ref: CastRef }),
  /** Taken down by this deployment. */
  z.object({ state: z.literal('removed'), ref: CastRef }),
]))
export type CastOrTombstone = z.infer<typeof CastOrTombstone>

export const User = named('User', UserSummary.extend({
  bio: utf8(256).optional(),
  url: HttpsUrl.optional(),
  location: utf8(64).optional(),
  banner: MediaKey.optional(),
  /** Where a send to this username goes. */
  primaryAddress: Address.optional(),
  verifications: z.array(z.object({ address: z.string().max(64), protocol: openEnum(['ethereum', 'solana']) })).max(LIMITS.verifications),
  /** Absent until counted. */
  followers: Count.optional(),
  following: Count.optional(),
  /** False when a count stopped at its bound and is shown as "N+". */
  countsExact: z.boolean(),
}))
export type User = z.infer<typeof User>

export const Channel = named('Channel', z.object({
  key: ChannelKey,
  name: utf8(256),
  description: utf8(1_024).optional(),
  image: MediaKey.optional(),
  /** The parent URL its casts carry. */
  url: ParentUrl,
  moderators: z.array(Fid).max(LIMITS.moderators),
  followers: Count.optional(),
}))
export type Channel = z.infer<typeof Channel>

export const StorageUsage = named('StorageUsage', z.object({
  pro: z.boolean(),
  stores: z.array(z.object({ type: openEnum(['casts', 'reactions', 'links', 'userData', 'verifications', 'usernameProofs']), used: Count, limit: Count })).max(16),
}))
export type StorageUsage = z.infer<typeof StorageUsage>

export const MODULES = ['core', 'miniapps', 'wallet', 'appFid', 'webLink', 'webApprovals'] as const
export type Module = (typeof MODULES)[number]

export const Capabilities = named('Capabilities', z.object({
  contract: SemVer,
  status: openEnum(['ok', 'degraded', 'readOnly']),
  modules: z.array(openEnum(MODULES)).max(16),
  /** Where the API, the media and the web app live. M1 has no media origin, so image fields are always absent. */
  origins: z.object({ api: OriginUrl, media: OriginUrl.optional(), web: OriginUrl.optional() }),
  appFid: Fid.nullable(),
  chains: z.array(z.object({ chainId: z.number().int().min(1), simulation: z.boolean(), eip7702: z.boolean() })).max(16),
  miniappNotifications: z.boolean(),
  walletActivity: z.boolean(),
}))
export type Capabilities = z.infer<typeof Capabilities>

/** A key that can sign for a FID: an onchain signer or a gasless app key, from the node's unified signer list. */
export const AppKey = named('AppKey', z.object({
  key: z.string().regex(/^0x[0-9a-f]{64}$/),
  source: openEnum(['onchain', 'gasless']),
  /** Message type numbers a gasless key may sign; empty for onchain keys, which may sign anything. */
  scopes: z.array(z.number().int().min(0).max(255)).max(32),
  requestFid: Fid.optional(),
  addedAt: Timestamp.optional(),
  lastUsedAt: Timestamp.optional(),
  expiresAt: Timestamp.optional(),
}))
export type AppKey = z.infer<typeof AppKey>

/** Who holds the account and what can sign for it, with the nonces a new key operation needs. */
export const Account = named('Account', z.object({
  fid: Fid,
  /** The custody address, which owns the FID. */
  custody: Address,
  /** The FID's gasless user nonce; a `KEY_ADD` or custody `KEY_REMOVE` uses a larger one. */
  userNonce: Count,
  /** The app nonce for keys this FID requested itself, used by self-revocation. */
  appNonce: Count,
  keys: z.array(AppKey).max(1_000),
}))
export type Account = z.infer<typeof Account>

/** A FID's own recent likes and recasts and who it follows, so its screens show them filled in. */
export const ViewerState = named('ViewerState', z.object({
  likes: z.array(CastHash).max(1_000),
  recasts: z.array(CastHash).max(1_000),
  following: z.array(Fid).max(5_000),
  /** False when a list stopped at its bound. */
  complete: z.boolean(),
}))
export type ViewerState = z.infer<typeof ViewerState>

/** A hex-encoded app key: an Ed25519 public key. */
export const KeyHex = z.string().regex(/^0x[0-9a-f]{64}$/)

/**
 * A session challenge: `challenge` is opaque and goes back to
 * `session.verify` as is; `nonce` is the 32 bytes the app key signs through `signSession`.
 * There is deliberately no origin here: the client signs the origin it was configured with,
 * never one a server names, so a deployment can't relay another deployment's challenge to the
 * phone and use the signature there.
 */
export const SessionChallenge = named('SessionChallenge', z.object({
  challenge: z.string().min(1).max(256).regex(/^[A-Za-z0-9_.-]+$/),
  nonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  expiresAt: Timestamp,
}))
export type SessionChallenge = z.infer<typeof SessionChallenge>

export const Session = named('Session', z.object({
  /** A bearer token, `{fid}.{random}.{mac}`; sent only on session routes and `messages.submit`. */
  token: z.string().min(1).max(256).regex(/^[A-Za-z0-9_.-]+$/),
  expiresAt: Timestamp,
}))
export type Session = z.infer<typeof Session>

/**
 * A FID's custody, nonces and the state of one key, read fresh from the node, for first
 * sign-in before any session exists and for key operations after.
 */
export const SignerRegistration = named('SignerRegistration', z.object({
  custody: Address,
  /** The FID's gasless user nonce; a `KEY_ADD` or custody `KEY_REMOVE` uses a larger one. */
  nonce: Count,
  /** The app nonce for keys this FID requested itself, used by self-revocation. */
  appNonce: Count,
  /** `removed` only when the node still knows the key; a revoked key usually reads `absent`. Security-relevant, so closed. */
  key: z.object({ state: z.enum(['absent', 'active', 'removed']), expiresAt: Timestamp.optional() }),
}))
export type SignerRegistration = z.infer<typeof SignerRegistration>

/** What the user object knows of the user's own history: still loading, complete, or with a gap it couldn't fill. */
export const HistoryState = openEnum(['backfilling', 'complete', 'gap'])

/** The user's own likes and recasts, all time, from the user object. While `backfilling`, an absent hash means "not known yet". */
export const ViewerReactions = named('ViewerReactions', z.object({
  likes: z.array(CastHash).max(1_000),
  recasts: z.array(CastHash).max(1_000),
  history: HistoryState,
}), { viewerScoped: true })
export type ViewerReactions = z.infer<typeof ViewerReactions>

/** Who the user follows and blocks, all time, from the user object. */
export const ViewerLinks = named('ViewerLinks', z.object({
  following: z.array(Fid).max(5_000),
  blocking: z.array(Fid).max(5_000),
  history: HistoryState,
}), { viewerScoped: true })
export type ViewerLinks = z.infer<typeof ViewerLinks>

/** Whether ingestion has seen one of the session's own messages merge. `unknown` covers pending, refused and too old. */
export const MessageState = z.enum(['merged', 'unknown'])

/**
 * One row of the inbox: a group, newest activity first. Likes
 * and recasts group per cast, follows per day; replies, mentions and quotes are a row each.
 * `cast` is the user's own cast for likes and recasts and the new cast otherwise, when it can
 * be read; `actors` are the newest few, `count` all of them.
 */
export const Notification = named('Notification', z.object({
  id: z.string().min(1).max(128),
  kind: openEnum(['reply', 'mention', 'quote', 'follow', 'like', 'recast']),
  ts: Timestamp,
  count: Count,
  actors: z.array(UserSummary).max(LIMITS.groupActors),
  cast: Cast.optional(),
  seen: z.boolean(),
}))
export type Notification = z.infer<typeof Notification>

export { Rev }
