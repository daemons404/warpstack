import { meta, ProcedureContract, type RouterContract } from '@orpc/contract'
import { z } from 'zod'
import { CastHash, ChannelKey, Count, Fid, Fname, HttpsUrl, Rev, Timestamp } from './codecs.ts'
import { define } from './define-routes.ts'
import {
  AppKey, Capabilities, Cast, CastOrTombstone, Channel, EmbedMetadata, KeyHex, MessageState, Notification, Session, SessionChallenge, SignerRegistration,
  StorageUsage, User, UserSummary, ViewerLinks, ViewerReactions,
} from './entities.ts'
import { LIMITS, MEDIA_UPLOAD_MAX_BYTES, VIDEO_LIMITS } from './limits.ts'
import { Cursor, page } from './pages.ts'

// The routes: M1's public reads, M1.5's write, and M2's sessions, which are the session
// routes, the signer routes, and the user's own reads, which take their FID from the session
// rather than the path. They replace M1.5's `account.*` reads, which were never released.
// Search, mini-app and wallet routes arrive later. The contract only grows.

const { call, read, write } = define
const CastRefInput = z.object({ fid: Fid, hash: CastHash })
const PageInput = { cursor: Cursor.optional() }

/**
 * oRPC v2's contract client needs each procedure's `meta.path` to match its place in the
 * router, so the paths are stamped on once here rather than repeated by hand.
 */
const withPaths = <T extends RouterContract>(router: T, path: string[] = []): T => {
  if (router instanceof ProcedureContract) {
    return (router as unknown as { meta: (p: unknown) => T }).meta(meta.path(path))
  }
  return Object.fromEntries(
    Object.entries(router).map(([k, v]) => [k, withPaths(v as RouterContract, [...path, k])]),
  ) as T
}

/**
 * The contract's version, which `meta.capabilities` reports. A change the snapshot test catches
 * (`__snapshots__/openapi.json`) bumps it: minor for an addition, major for anything an older
 * client would mis-read.
 */
export const CONTRACT_VERSION = '0.3.0'

export const contract = withPaths({
  feed: {
    /** Casts from the accounts the session follows, and its own, newest first. */
    following: read({
      path: '/api/feed/following', auth: 'session', fresh: '30s', cost: 'upstream', paged: true,
      input: z.object(PageInput),
      output: page(Cast),
    }),
    channel: read({
      path: '/api/channels/{key}/feed', auth: 'none', fresh: '30s', cost: 'db', paged: true,
      input: z.object({ key: ChannelKey, ...PageInput }),
      output: page(Cast),
    }),
    user: read({
      path: '/api/users/{fid}/feed', auth: 'none', fresh: '30s', cost: 'db', paged: true,
      // Past the index, older casts come from Snapchain.
      errors: ['UPSTREAM_UNAVAILABLE'],
      input: z.object({ fid: Fid, replies: z.boolean().optional(), ...PageInput }),
      output: page(Cast),
    }),
  },
  cast: {
    get: read({
      path: '/api/casts/{fid}/{hash}', auth: 'none', fresh: '30s', cost: 'db',
      errors: ['NOT_FOUND', 'UPSTREAM_UNAVAILABLE'],
      input: CastRefInput,
      output: z.object({ cast: CastOrTombstone, rev: Rev }),
    }),
    thread: read({
      path: '/api/casts/{fid}/{hash}/thread', auth: 'none', fresh: '30s', cost: 'db', paged: true,
      errors: ['NOT_FOUND', 'UPSTREAM_UNAVAILABLE'],
      input: CastRefInput.extend(PageInput),
      output: z.object({
        root: CastOrTombstone,
        /** Oldest first, up to the thread's top or the bound. */
        ancestors: z.array(Cast).max(LIMITS.ancestors),
        replies: page(Cast),
      }),
    }),
    /**
     * What one of an indexed cast's URL embeds is. Addressed by cast and position, never by
     * URL, so the server only ever fetches URLs that casts it has indexed embed.
     */
    embed: read({
      path: '/api/casts/{fid}/{hash}/embeds/{index}', auth: 'none', fresh: '3d', cost: 'upstream',
      errors: ['NOT_FOUND'],
      input: CastRefInput.extend({ index: z.number().int().min(0).max(LIMITS.embeds - 1) }),
      output: EmbedMetadata,
    }),
    reactors: read({
      path: '/api/casts/{fid}/{hash}/reactors', auth: 'none', fresh: '60s', cost: 'upstream', paged: true,
      input: CastRefInput.extend({ kind: z.enum(['like', 'recast']), ...PageInput }),
      output: page(UserSummary),
    }),
  },
  user: {
    get: read({
      path: '/api/users/{fid}', auth: 'none', fresh: '5m', cost: 'db',
      errors: ['NOT_FOUND', 'UPSTREAM_UNAVAILABLE'],
      input: z.object({ fid: Fid }),
      output: z.object({ user: User, rev: Rev }),
    }),
    byName: read({
      path: '/api/usernames/{username}', auth: 'none', fresh: '5m', cost: 'db',
      errors: ['NOT_FOUND', 'UPSTREAM_UNAVAILABLE'],
      input: z.object({ username: Fname }),
      output: z.object({ user: User, rev: Rev }),
    }),
    bulk: read({
      path: '/api/users', auth: 'none', fresh: '5m', cost: 'db',
      // Sorted and unique, so the URL, and the cache key, is canonical.
      input: z.object({ fids: z.array(Fid).min(1).max(LIMITS.userBulk).meta({ 'x-sortedUnique': true }) }),
      output: z.object({ users: z.array(UserSummary).max(LIMITS.userBulk), rev: Rev }),
    }),
    followers: read({
      path: '/api/users/{fid}/followers', auth: 'none', fresh: '5m', cost: 'upstream', paged: true,
      input: z.object({ fid: Fid, ...PageInput }),
      output: page(UserSummary),
    }),
    following: read({
      path: '/api/users/{fid}/following', auth: 'none', fresh: '5m', cost: 'upstream', paged: true,
      input: z.object({ fid: Fid, ...PageInput }),
      output: page(UserSummary),
    }),
    storage: read({
      path: '/api/users/{fid}/storage', auth: 'none', fresh: '5m', cost: 'upstream',
      input: z.object({ fid: Fid }),
      output: StorageUsage,
    }),
  },
  channel: {
    get: read({
      path: '/api/channels/{key}', auth: 'none', fresh: '1h', cost: 'db',
      errors: ['NOT_FOUND'],
      input: z.object({ key: ChannelKey }),
      output: z.object({ channel: Channel, rev: Rev }),
    }),
    list: read({
      path: '/api/channels', auth: 'none', fresh: '1h', cost: 'db', paged: true,
      input: z.object(PageInput),
      output: page(Channel),
    }),
  },
  messages: {
    /**
     * Verifies a signed message and submits it to the node. Every type but `KEY_ADD` needs a
     * session whose FID is the message's. `submitted` means the node validated and relayed it,
     * not that it merged: `messages.status` says when it has.
     */
    submit: write({
      path: '/api/messages', auth: 'message',
      errors: ['REJECTED'],
      input: z.object({ message: z.string().min(1).max(4_096).regex(/^[A-Za-z0-9_-]+$/) }),
      output: z.object({ hash: CastHash, state: z.enum(['submitted']) }),
    }),
    /** Which of the session's own messages ingestion has seen merge. `hashes` is comma-separated, at most 50. */
    status: read({
      path: '/api/messages/status', auth: 'session', fresh: '0s', cost: 'object',
      input: z.object({ hashes: z.string().regex(/^0x[0-9a-f]{40}(?:,0x[0-9a-f]{40}){0,49}$/) }),
      output: z.object({ states: z.record(CastHash, MessageState) }),
    }),
  },
  session: {
    /** A stateless, MAC'd challenge for one FID and key. Touches no user object. */
    challenge: call({
      path: '/api/session/challenge', auth: 'none', cost: 'worker',
      input: z.object({ fid: Fid, key: KeyHex }),
      output: SessionChallenge,
    }),
    /** Exchanges the app key's signature over the challenge for a session token, once the key is active for the FID. */
    verify: call({
      path: '/api/session/verify', auth: 'none', cost: 'upstream',
      input: z.object({
        fid: Fid, key: KeyHex,
        challenge: SessionChallenge.shape.challenge,
        signature: z.string().regex(/^0x[0-9a-f]{128}$/),
        /** A stable per-install ID, so a push token can be tied to this session's device. */
        device: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
      }),
      output: Session,
    }),
    /**
     * A token that opens avatars and proxied images on a private media origin, appended to
     * image URLs as `?t=`. It names no one: the media origin learns only that some allowed user asked.
     */
    media: read({
      path: '/api/session/media', auth: 'session', fresh: '1h', cost: 'worker',
      output: z.object({ token: z.string().max(128), expiresAt: Timestamp }),
    }),
    /** Ends this session, and its device's push token. Other devices stay signed in. */
    end: call({
      path: '/api/session/end', auth: 'session', cost: 'object',
      output: z.object({ ok: z.literal(true) }),
    }),
  },
  signer: {
    /** The app FID's half of a key request. With no app FID configured it returns `MODULE_DISABLED`, and the FID requests its own key. */
    request: call({
      path: '/api/signers/request', auth: 'none', cost: 'worker', module: 'appFid',
      input: z.object({ key: KeyHex, domain: z.enum(['gasless', 'onchain']) }),
      output: z.object({ requestFid: Fid, requestSigner: z.string().regex(/^0x[0-9a-f]{40}$/), deadline: z.number().int().min(1), signature: z.string().regex(/^0x[0-9a-f]{130}$/) }),
    }),
    /** Custody, nonces and one key's state, fresh from the node: for first sign-in, before a session exists. */
    registration: read({
      path: '/api/signers/registration', auth: 'none', fresh: '0s', cost: 'upstream',
      errors: ['NOT_FOUND'],
      input: z.object({ fid: Fid, key: KeyHex }),
      output: SignerRegistration,
    }),
    /** The session FID's keys, onchain and gasless, with scopes and expiry. */
    list: read({
      path: '/api/signers', auth: 'session', fresh: '0s', cost: 'upstream',
      output: z.object({ signers: z.array(AppKey).max(1_000) }),
    }),
  },
  notifications: {
    /** The session's inbox, grouped, newest first: from its user object, which ingestion fills. */
    list: read({
      path: '/api/notifications', auth: 'session', fresh: '10s', cost: 'object', paged: true,
      input: z.object(PageInput),
      output: page(Notification),
    }),
    /** How many groups are new since the user last looked: the tab's badge. */
    unseen: read({
      path: '/api/notifications/unseen', auth: 'session', fresh: '10s', cost: 'object',
      output: z.object({ count: Count }),
    }),
    /** Marks every group up to `upTo` as seen. */
    markSeen: call({
      path: '/api/notifications/seen', auth: 'session', cost: 'object',
      input: z.object({ upTo: Timestamp }),
      output: z.object({ ok: z.literal(true) }),
    }),
  },
  viewer: {
    /** The session's own likes and recasts, all time, from its user object. */
    reactions: read({
      path: '/api/viewer/reactions', auth: 'session', fresh: '0s', cost: 'object',
      output: ViewerReactions,
    }),
    /**
     * The channels the session's FID follows on Farcaster, for the device to import once. Channel
     * follows aren't on protocol until V21, so this reads the Farcaster client API and the server
     * keeps nothing: the device holds its own list from then on.
     */
    channels: read({
      path: '/api/viewer/channels', auth: 'session', fresh: '0s', cost: 'upstream',
      errors: ['MODULE_DISABLED'],
      output: z.object({ channels: z.array(Channel).max(1_000) }),
    }),
    /** Who the session follows and blocks, all time, from its user object. */
    links: read({
      path: '/api/viewer/links', auth: 'session', fresh: '0s', cost: 'object',
      output: ViewerLinks,
    }),
  },
  media: {
    /**
     * Uploads one image for a cast: the bytes as the body, already resized and stripped of
     * metadata on the device. The server checks them, refuses any that still carry metadata,
     * re-encodes them and stores them publicly on the media origin. Returns the URL to embed.
     */
    upload: call({
      path: '/api/media', auth: 'session', cost: 'db',
      errors: ['MODULE_DISABLED', 'REJECTED'],
      // The body is the image itself, sent by the oRPC client as a file. Its type is read from its bytes.
      input: z.file().max(MEDIA_UPLOAD_MAX_BYTES),
      output: z.object({ url: HttpsUrl, width: z.number().int().min(1).max(10_000), height: z.number().int().min(1).max(10_000) }),
    }),
  },
  video: {
    /**
     * Starts a video upload: a one-time URL on the deployment's own Cloudflare Stream that the
     * device sends the file to directly. Stream refuses anything longer than
     * `VIDEO_LIMITS.maxSeconds`. Counted per member and per deployment per day.
     */
    upload: call({
      path: '/api/video', auth: 'session', cost: 'upstream',
      errors: ['MODULE_DISABLED', 'REJECTED'],
      output: z.object({ id: z.string().regex(/^[0-9a-f]{32}$/), uploadUrl: HttpsUrl, maxSeconds: z.literal(VIDEO_LIMITS.maxSeconds) }),
    }),
    /**
     * Where an upload is: processing, ready (with the URL to embed) or failed. Only the member
     * who started it can ask.
     */
    status: call({
      path: '/api/video/{id}', auth: 'session', cost: 'upstream',
      errors: ['MODULE_DISABLED', 'NOT_FOUND'],
      input: z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }),
      output: z.discriminatedUnion('state', [
        z.object({ state: z.literal('processing') }),
        z.object({ state: z.literal('ready'), url: HttpsUrl }),
        z.object({ state: z.literal('failed'), reason: z.string().max(300) }),
      ]),
    }),
  },
  meta: {
    capabilities: read({
      path: '/api/meta', auth: 'none', fresh: '5m', cost: 'worker',
      output: Capabilities,
    }),
  },
})

export type Contract = typeof contract
