import { cacheControlOf, contract, getFacts, LIMITS, MEDIA_UPLOAD_MAX_BYTES, PRE_SESSION_PATHS, VIDEO_LIMITS, type Capabilities, type Facts } from '@warpstack/contract'
import { implement, ORPCError } from '@orpc/server'
import type { CastHash, Fid, Result } from '@warpstack/protocol'
import type { Admission } from './config.ts'
import { makeMediaToken } from './core/media-token.ts'
import { readUpTo, type Limiters } from './front.ts'
import { TransientError, type Media } from './media.ts'
import type { Videos } from './videos.ts'
import type { ChannelRegistry, Mac } from './ports.ts'
import type { ReadError, Reads } from './reads.ts'
import type { SessionContext, SessionError, Sessions } from './sessions.ts'
import type { WriteError, Writes } from './writes.ts'

export type RouterContext = {
  reads: Reads
  /** Images and link previews; stores nothing without R2 and the Images binding. */
  media: Media
  /** Members' videos on Stream, and which video URLs may play; uploads are off without Stream. */
  videos: Videos
  writes: Writes
  sessions: Sessions
  capabilities: Capabilities
  /** The bearer token from the Authorization header, if any. */
  token: string | null
  limiters: Limiters
  /** Who may use this deployment, for the pre-session routes that check it themselves. */
  admission: Admission
  /** `public`: anonymous reads (the open client). `private`: every read needs an allowed user's session. */
  access: 'private' | 'public'
  /** Makes media tokens; absent when media isn't private. */
  mediaMac?: Mac | undefined
  now: () => number
  /** Channel metadata and, where the registry knows them, a FID's followed channels. */
  channels?: ChannelRegistry | undefined
  resHeaders?: Headers
}

const os = implement(contract).$context<RouterContext>()

/**
 * Enforcement derived from the route's facts, read from the procedure being served. Rate
 * limits, token presence and body size were checked before decoding (`front.ts`); this checks
 * the session itself where a private deployment gates a public read, and sets Cache-Control
 * after the handler, which Workers Cache honours.
 */
const facts = os.middleware(async ({ context, procedure, next }) => {
  const f = getFacts(procedure) as Facts | undefined
  if (!f) throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'a route without facts' })
  // Private: reads anyone could make on a public client need an allowed user's session here.
  // The handler still sees no viewer, so reads stay the same for every user.
  const gated = context.access === 'private' && f.auth === 'none' && !PRE_SESSION_PATHS.has(f.path)
  if (gated) {
    const s = await context.sessions.authenticate(context.token)
    if (!s.ok) sessionError(s.error)
  }
  const result = await next()
  // A gated read is never stored in a shared cache.
  context.resHeaders?.set('cache-control', cacheControlOf(gated ? { ...f, auth: 'session' } : f))
  return result
})

const pub = os.use(facts)

const sessionError = (e: SessionError): never => {
  switch (e.kind) {
    case 'challenge': throw new ORPCError('UNAUTHORIZED', { message: 'The challenge is expired, used or not for this key', data: { reason: 'challenge' } })
    case 'origin': throw new ORPCError('UNAUTHORIZED', { message: 'The challenge was signed for another origin', data: { reason: 'origin' } })
    case 'signature': throw new ORPCError('UNAUTHORIZED', { message: 'The signature does not match', data: { reason: 'signature' } })
    case 'key_inactive': throw new ORPCError('UNAUTHORIZED', { message: 'This key is not active for this FID', data: { reason: 'keyInactive' } })
    case 'not_accepted': throw new ORPCError('UNAUTHORIZED', { message: 'This deployment does not accept sessions from this key', data: { reason: 'keyNotAccepted' } })
    case 'session': throw new ORPCError('UNAUTHORIZED', { message: 'Sign in again', data: { reason: 'session' } })
    case 'upstream': throw new ORPCError('UPSTREAM_UNAVAILABLE', { cause: e.detail })
    case 'read_only': throw new ORPCError('READ_ONLY')
  }
}

/**
 * The `session` scheme: the token's MAC is checked in the Worker, then its hash by the user
 * object it names. Only this middleware hands a handler a FID or a user object, so no handler
 * can reach another user's object from a FID in the request.
 */
const withSession = pub.use(async ({ context, next }) => {
  const s = await context.sessions.authenticate(context.token)
  if (!s.ok) return sessionError(s.error)
  return next({ context: { session: s.value as SessionContext } })
})

/** Maps the read service's errors onto the contract's. Anything else is a bug and surfaces as a 500. */
const unwrap = <T>(r: Result<T, ReadError>): T => {
  if (r.ok) return r.value
  switch (r.error.kind) {
    case 'not_found': throw new ORPCError('NOT_FOUND')
    case 'cursor_invalid': throw new ORPCError('CURSOR_INVALID')
    case 'upstream': throw new ORPCError('UPSTREAM_UNAVAILABLE', { cause: r.error.detail })
  }
}

const unwrapWrite = <T>(r: Result<T, WriteError>): T => {
  if (r.ok) return r.value
  switch (r.error.kind) {
    case 'bad_input': throw new ORPCError('BAD_INPUT', { data: { issues: [{ path: 'message', message: r.error.detail }] } })
    case 'rejected': throw new ORPCError('REJECTED', { data: { reason: r.error.detail } })
    case 'no_session': throw new ORPCError('UNAUTHORIZED', { message: 'Sign in again: this message needs a session', data: { reason: 'session' } })
    case 'fid_mismatch': throw new ORPCError('UNAUTHORIZED', { message: 'The message is for another FID than the session', data: { reason: 'fidMismatch' } })
    case 'rate_limited': throw new ORPCError('RATE_LIMITED', { data: { retryAfter: 60 } })
    case 'key_inactive': throw new ORPCError('UNAUTHORIZED', { message: 'This key is not active for this FID', data: { reason: 'keyInactive' } })
    case 'read_only': throw new ORPCError('READ_ONLY')
    case 'upstream': throw new ORPCError('UPSTREAM_UNAVAILABLE', { cause: r.error.detail })
  }
}

export const router = pub.router({
  feed: {
    following: withSession.feed.following.handler(async ({ input, context }) => unwrap(await context.reads.home(context.session.fid, input.cursor))),
    channel: pub.feed.channel.handler(async ({ input, context }) => unwrap(await context.reads.channelFeed(input.key, input.cursor))),
    user: pub.feed.user.handler(async ({ input, context }) => unwrap(await context.reads.userFeed(input.fid, input.replies ?? false, input.cursor))),
  },
  cast: {
    get: pub.cast.get.handler(async ({ input, context }) => unwrap(await context.reads.cast(input.fid, input.hash))),
    thread: pub.cast.thread.handler(async ({ input, context }) => unwrap(await context.reads.thread(input.fid, input.hash, input.cursor))),
    embed: pub.cast.embed.handler(async ({ input, context }) => {
      const url = unwrap(await context.reads.embedUrl(input.fid, input.hash, input.index))
      // A video plays only from Farcaster's servers or this deployment's uploads; decided without a fetch.
      const video = await context.videos.embed(url)
      if (video) return video as never
      try {
        return await context.media.embed(url)
      } catch (e) {
        // Busy or unreachable right now: an error, so the answer isn't cached for days.
        if (e instanceof TransientError) throw new ORPCError('UPSTREAM_UNAVAILABLE', { cause: e.message })
        throw e
      }
    }),
    reactors: pub.cast.reactors.handler(async ({ input, context }) =>
      unwrap(await context.reads.reactors(input.fid, input.hash, input.kind, input.cursor))),
  },
  user: {
    get: pub.user.get.handler(async ({ input, context }) => unwrap(await context.reads.user(input.fid))),
    byName: pub.user.byName.handler(async ({ input, context }) => unwrap(await context.reads.userByName(input.username))),
    bulk: pub.user.bulk.handler(async ({ input, context }) => unwrap(await context.reads.usersBulk(input.fids as Fid[]))),
    followers: pub.user.followers.handler(async ({ input, context }) => unwrap(await context.reads.followers(input.fid, input.cursor))),
    following: pub.user.following.handler(async ({ input, context }) => unwrap(await context.reads.following(input.fid, input.cursor))),
    storage: pub.user.storage.handler(async ({ input, context }) => unwrap(await context.reads.storage(input.fid))),
  },
  channel: {
    get: pub.channel.get.handler(async ({ input, context }) => unwrap(await context.reads.channel(input.key))),
    list: pub.channel.list.handler(async ({ input, context }) => unwrap(await context.reads.channels(input.cursor))),
  },
  messages: {
    // The `message` scheme: the signed message is the credential, and a session is optional
    // here because a `KEY_ADD` has none yet; `Writes` requires one for every other type.
    submit: pub.messages.submit.handler(async ({ input, context }) => {
      const s = context.token ? await context.sessions.authenticate(context.token) : null
      if (s && !s.ok && s.error.kind === 'upstream') sessionError(s.error)
      const r = unwrapWrite(await context.writes.submit(input.message, {
        sessionFid: s?.ok ? s.value.fid : null,
        limitFid: async fid => (await context.limiters.WRITE_FID.limit({ key: `WRITE_FID:${fid}` })).success,
      }))
      return { hash: r.hash as CastHash, state: 'submitted' as const }
    }),
    status: withSession.messages.status.handler(async ({ input, context }) => {
      const hashes = [...new Set(input.hashes.split(','))]
      return { states: await context.session.user.status(context.session.fid, hashes) as Record<CastHash, 'merged' | 'unknown'> }
    }),
  },
  session: {
    media: withSession.session.media.handler(async ({ context }) => {
      if (!context.mediaMac) throw new ORPCError('MODULE_DISABLED', { data: { module: 'media' } })
      const t = await makeMediaToken(context.mediaMac, context.now())
      return { token: t.token, expiresAt: t.expiresAt as never }
    }),
    challenge: pub.session.challenge.handler(async ({ input, context }) => {
      const c = await context.sessions.challenge(input.fid, input.key)
      return { challenge: c.challenge, nonce: c.nonce, expiresAt: c.expiresAt as never }
    }),
    verify: pub.session.verify.handler(async ({ input, context }) => {
      const r = await context.sessions.verify(input)
      if (!r.ok) return sessionError(r.error)
      return { token: r.value.token, expiresAt: r.value.expiresAt as never }
    }),
    end: withSession.session.end.handler(async ({ context }) => {
      await context.session.user.endSession(context.session.fid, context.session.tokenHash)
      return { ok: true as const }
    }),
  },
  signer: {
    // v1 deployments have no app FID: the FID requests its own key.
    request: pub.signer.request.handler(() => {
      throw new ORPCError('MODULE_DISABLED', { message: 'This deployment has no app FID; the FID requests its own key', data: { module: 'appFid' } })
    }),
    registration: pub.signer.registration.handler(async ({ input, context }) => {
      // Polled during first sign-in, before any session. With only a list of FIDs it answers only
      // for them; with an app FID it can't know which app asked for the key until it reads the node.
      const adm = context.admission
      if (!adm.public && adm.appFid === undefined && !adm.allowed.has(input.fid)) {
        throw new ORPCError('UNAUTHORIZED', { message: 'This deployment does not accept this FID', data: { reason: 'keyNotAccepted' } })
      }
      const a = unwrap(await context.reads.account(input.fid))
      const k = a.keys.find(x => x.key === input.key)
      return {
        custody: a.custody, nonce: a.userNonce, appNonce: a.appNonce,
        key: k ? { state: 'active' as const, ...(k.expiresAt ? { expiresAt: k.expiresAt } : {}) } : { state: 'absent' as const },
      }
    }),
    list: withSession.signer.list.handler(async ({ context }) => ({ signers: unwrap(await context.reads.account(context.session.fid)).keys })),
  },
  notifications: {
    list: withSession.notifications.list.handler(async ({ input, context }) => {
      const { fid, user } = context.session
      // The first look fills the inbox with what happened before it existed, once.
      if (!input.cursor && !(await user.inboxFilled(fid))) {
        const notes = await context.reads.inboxHistory(fid)
        if (notes) await user.fillInbox(fid, notes)
      }
      const before = unwrap(await context.reads.notificationsCursor(fid, input.cursor))
      const groups = await user.inbox(fid, before, LIMITS.pageSize + 1)
      return unwrap(await context.reads.notifications(fid, groups.slice(0, LIMITS.pageSize), groups.length > LIMITS.pageSize))
    }),
    unseen: withSession.notifications.unseen.handler(async ({ context }) =>
      ({ count: await context.session.user.unseen(context.session.fid) as never })),
    markSeen: withSession.notifications.markSeen.handler(async ({ input, context }) => {
      await context.session.user.markSeen(context.session.fid, input.upTo)
      return { ok: true as const }
    }),
  },
  viewer: {
    channels: withSession.viewer.channels.handler(async ({ context }) => {
      const registry = context.channels
      if (!registry?.followedBy) throw new ORPCError('MODULE_DISABLED', { message: 'This deployment has no channel registry that knows follows', data: { module: 'channels' } })
      const r = await registry.followedBy(context.session.fid)
      if (!r.ok) throw new ORPCError('UPSTREAM_UNAVAILABLE', { cause: r.error.detail })
      return { channels: (await context.reads.presentChannels(r.value.slice(0, 1_000))) }
    }),
    reactions: withSession.viewer.reactions.handler(async ({ context }) => {
      const r = await context.session.user.reactions(context.session.fid)
      return { likes: r.likes as CastHash[], recasts: r.recasts as CastHash[], history: r.history }
    }),
    links: withSession.viewer.links.handler(async ({ context }) => {
      const r = await context.session.user.links(context.session.fid)
      return { following: r.following as Fid[], blocking: r.blocking as Fid[], history: r.history }
    }),
  },
  media: {
    upload: withSession.media.upload.handler(async ({ input, context }) => {
      if (!context.media.uploads) throw new ORPCError('MODULE_DISABLED', { message: 'Images are off on this deployment', data: { module: 'media' } })
      // Uploads share the per-FID write budget: a member can't fill the bucket faster than they can post.
      if (!(await context.limiters.WRITE_FID.limit({ key: `WRITE_FID:${context.session.fid}` })).success) {
        throw new ORPCError('RATE_LIMITED', { data: { retryAfter: 60 } })
      }
      const body = await readUpTo((input as unknown as Blob).stream(), MEDIA_UPLOAD_MAX_BYTES)
      if (!body) throw new ORPCError('REJECTED', { data: { reason: `the image is over ${MEDIA_UPLOAD_MAX_BYTES / 1_048_576} MB` } })
      const r = await context.media.storeUpload(body, context.session.fid)
      if (!r.ok) throw new ORPCError('REJECTED', { data: { reason: r.error.why.slice(0, 300) } })
      return { url: r.value.url as never, width: r.value.width, height: r.value.height }
    }),
  },
  video: {
    upload: withSession.video.upload.handler(async ({ context }) => {
      const fid = context.session.fid
      if (!context.videos.enabled) throw new ORPCError('MODULE_DISABLED', { message: 'Video uploads are off on this server', data: { module: 'videoUploads' } })
      // Each video costs the owner money, so on a public server only the listed FIDs may upload.
      if (context.admission.public && !context.admission.allowed.has(fid)) {
        throw new ORPCError('REJECTED', { data: { reason: 'Only this server\'s own members can post videos.' } })
      }
      if (!(await context.limiters.WRITE_FID.limit({ key: `WRITE_FID:${fid}` })).success) throw new ORPCError('RATE_LIMITED', { data: { retryAfter: 60 } })
      const r = await context.videos.start(fid)
      if (r.ok) return { id: r.value.id, uploadUrl: r.value.uploadUrl as never, maxSeconds: VIDEO_LIMITS.maxSeconds }
      switch (r.error.kind) {
        case 'limit': throw new ORPCError('REJECTED', { data: { reason: r.error.why } })
        case 'upstream': throw new ORPCError('UPSTREAM_UNAVAILABLE', { cause: r.error.detail })
        default: throw new ORPCError('MODULE_DISABLED', { message: 'Video uploads are off on this server', data: { module: 'videoUploads' } })
      }
    }),
    status: withSession.video.status.handler(async ({ input, context }) => {
      const r = await context.videos.status(input.id, context.session.fid)
      if (r.ok) return r.value.state === 'ready' ? { state: 'ready' as const, url: r.value.url as never } : r.value
      switch (r.error.kind) {
        case 'not_found': throw new ORPCError('NOT_FOUND')
        case 'upstream': throw new ORPCError('UPSTREAM_UNAVAILABLE', { cause: r.error.detail })
        default: throw new ORPCError('MODULE_DISABLED', { message: 'Video uploads are off on this server', data: { module: 'videoUploads' } })
      }
    }),
  },
  meta: {
    capabilities: pub.meta.capabilities.handler(({ context }) => context.capabilities),
  },
})
