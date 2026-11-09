import { CONTRACT_VERSION, ERROR_STATUS, type Capabilities } from '@warpstack/contract'
import { COMMON_ERROR_STATUS_MAP } from '@orpc/client'
import { SmartCoercionHandlerPlugin } from '@orpc/json-schema'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { ORPCError, ValidationError } from '@orpc/server'
import { ResponseHeadersHandlerPlugin } from '@orpc/server/plugins'
import { Hono } from 'hono'
import { DATA_SHARDS, type Fid } from '@warpstack/protocol'
import { FarcasterChannelRegistry } from './adapters/channel-registry.ts'
import { D1Sql } from './adapters/d1.ts'
import { HmacMac } from './adapters/hmac.ts'
import { systemRandom } from './adapters/random.ts'
import { IndexMaintenance } from './adapters/index-maintenance.ts'
import { IndexReader } from './adapters/index-reader.ts'
import { snapchainOf } from './adapters/snapchain-pool.ts'
import { systemClock } from './adapters/clock.ts'
import { hostOf } from './adapters/fetchers/index.ts'
import { admissionOf, parseConfig, type Config } from './config.ts'
import { Media } from './media.ts'
import type { Env } from './env.ts'
import type { Snapchain } from './ports.ts'
import { readOnlySnapchain } from './read-only.ts'
import { bearer } from './core/session.ts'
import { Reads } from './reads.ts'
import { Sessions } from './sessions.ts'
import type { UserApi } from './user-object.ts'
import { Writes } from './writes.ts'
import { admit, refusal } from './front.ts'
import { callerKey } from './core/ip.ts'
import { router, type RouterContext } from './router.ts'

/**
 * Input that fails its schema becomes the contract's `BAD_INPUT`, with the issues listed;
 * oRPC calls it `BAD_REQUEST`.
 */
const badInput = async <T>({ next }: { next: () => Promise<T> }): Promise<T> => {
  try {
    return await next()
  } catch (e) {
    if (e instanceof ORPCError && e.code === 'BAD_REQUEST' && e.cause instanceof ValidationError) {
      const issues = e.cause.issues.slice(0, 20).map(i => ({
        path: (i.path ?? []).map(p => String(typeof p === 'object' ? p.key : p)).join('.').slice(0, 256),
        message: i.message.slice(0, 256),
      }))
      throw new ORPCError('BAD_INPUT', { data: { issues }, cause: e })
    }
    throw e
  }
}

export const handler = new OpenAPIHandler<RouterContext>(router, {
  errorStatusMap: { ...COMMON_ERROR_STATUS_MAP, ...ERROR_STATUS },
  // Path and query values arrive as strings; smart coercion converts them by the schema.
  plugins: [new SmartCoercionHandlerPlugin(), new ResponseHeadersHandlerPlugin()],
  clientInterceptors: [badInput],
})

export const capabilitiesOf = (config: Config, origin: string, env: Pick<Env, 'MEDIA' | 'IMAGES'> = {}): Capabilities => ({
  contract: CONTRACT_VERSION,
  status: config.readOnly ? 'readOnly' : 'ok',
  modules: ['core'],
  // The media origin is named only when images can be stored and served.
  origins: { api: origin, ...(mediaReady(config, env) ? { media: config.mediaOrigin! } : {}) },
  appFid: (config.appFid ?? null) as Fid | null,
  chains: [],
  miniappNotifications: false,
  walletActivity: false,
})

const mediaReady = (config: Config, env: Pick<Env, 'MEDIA' | 'IMAGES'>) => Boolean(config.mediaOrigin && env.MEDIA && env.IMAGES)

/** The fetchers never reach our own services: the API, the media origin or the Snapchain node. */
export const mediaOf = (config: Config, env: Env, apiOrigin: string): Media => new Media({
  db: new D1Sql(env.DB),
  clock: systemClock,
  policy: { deny: [apiOrigin, config.origin, config.mediaOrigin, ...config.snapchain.nodes].map(hostOf).filter((h): h is string => h !== null) },
  bucket: mediaReady(config, env) ? env.MEDIA : undefined,
  images: mediaReady(config, env) ? env.IMAGES : undefined,
  // Without the binding, the per-isolate limit in the transport is the only guard.
  admit: async () => (env.FETCH_ALL ? (await env.FETCH_ALL.limit({ key: 'all' })).success : true),
  mediaOrigin: mediaReady(config, env) ? config.mediaOrigin : undefined,
})

/** Sessions for this request: the handshake, and the check every gated route runs. */
const sessionsOf = (config: Config, env: Env, db: D1Sql, snapchain: Snapchain): Sessions => new Sessions({
  mac: new HmacMac(config.sessionKey),
  random: systemRandom,
  clock: systemClock,
  snapchain,
  db,
  users: fid => env.USER.get(env.USER.idFromName(String(fid))) as unknown as UserApi,
  origin: config.origin,
  acceptKeysFrom: config.acceptKeysFrom === 'appFid' && config.appFid ? { kind: 'appFid', fid: config.appFid } : { kind: 'any' },
  admission: admissionOf(config),
  readOnly: config.readOnly,
})

type HonoEnv = { Bindings: Env }

/**
 * The Worker's HTTP surface. Public reads are cached by Workers Cache in front of the
 * Worker (`"cache": { "enabled": true }` in wrangler config), from the Cache-Control each
 * route's facts set; it bypasses any request with an Authorization header.
 */
export const createApp = () => {
  const app = new Hono<HonoEnv>()
  // Ingestion starts on the first request an isolate sees, and the watchdog cron keeps it
  // running, so a fresh deployment needs no manual step.
  let ensured = false

  app.all('/api/*', async c => {
    const config = parseConfig(c.env)
    const limiters = { READ_IP: c.env.READ_IP, UPSTREAM_IP: c.env.UPSTREAM_IP, WRITE_FID: c.env.WRITE_FID }
    // Limits, token presence and body size, before oRPC reads the body.
    const admitted = await admit(c.req.raw, { ip: c.req.header('cf-connecting-ip') ?? 'local', access: config.access, limiters })
    if (!admitted.ok) return admitted.response
    if (!ensured) {
      ensured = true
      c.executionCtx.waitUntil(ensureIngestion(c.env).catch(e => console.error(`ensure ingestion: ${String(e)}`)))
    }
    const db = new D1Sql(c.env.DB)
    const http = snapchainOf(config.snapchain)
    const snapchain = config.readOnly ? readOnlySnapchain(http) : http
    const media = mediaOf(config, c.env, new URL(c.req.url).origin)
    // Avatars a response names that aren't stored yet are fetched after it's sent.
    const wantAvatars = media.enabled
      ? (srcs: string[]) => c.executionCtx.waitUntil(media.storeAvatars(srcs))
      : undefined
    const reads = new Reads(new IndexReader(db), new IndexMaintenance(db), snapchain, new HmacMac(config.cursorKey), systemClock, wantAvatars, config.retentionDays)
    const admission = admissionOf(config)
    const writes = new Writes(http, systemClock, config.readOnly, false, admission)
    const sessions = sessionsOf(config, c.env, db, snapchain)
    const { matched, response } = await handler.handle(admitted.request, {
      context: {
        reads,
        media,
        writes,
        sessions,
        capabilities: capabilitiesOf(config, new URL(c.req.url).origin, c.env),
        token: bearer(c.req.header('authorization')),
        limiters,
        access: config.access,
        admission,
        mediaMac: config.mediaKey ? new HmacMac(config.mediaKey) : undefined,
        now: () => systemClock.now(),
        channels: config.channelRegistry === 'farcaster' ? new FarcasterChannelRegistry() : undefined,
      },
    })
    if (matched) {
      // Errors skip the facts middleware's Cache-Control; nothing without one may be cached.
      if (!response.headers.has('cache-control')) response.headers.set('cache-control', 'no-store')
      return response
    }
    return c.json({ defined: true, code: 'NOT_FOUND', message: 'No such route' }, 404, { 'cache-control': 'no-store' })
  })

  // Operations: ingestion progress per shard. Public facts only; nothing here is a secret.
  app.get('/_ops/status', async c => {
    const db = new D1Sql(c.env.DB)
    const config = parseConfig(c.env)
    // Held to the upstream class's limits: it reads every shard's object and counts the index.
    const caller = callerKey(c.req.header('cf-connecting-ip') ?? 'local')
    for (const binding of ['READ_IP', 'UPSTREAM_IP'] as const) {
      if (!(await c.env[binding].limit({ key: `${binding}:${caller}` })).success) return refusal('RATE_LIMITED', { retryAfter: 60 }, { 'retry-after': '60' })
    }
    // Private deployments show their ingestion only to signed-in users.
    if (config.access === 'private') {
      const http = snapchainOf(config.snapchain)
      const s = await sessionsOf(config, c.env, db, config.readOnly ? readOnlySnapchain(http) : http).authenticate(bearer(c.req.header('authorization')))
      if (!s.ok) return c.json({ defined: true, code: 'UNAUTHORIZED', message: 'Sign in to see this deployment\'s status', data: { reason: 'session' } }, 401, { 'cache-control': 'no-store' })
    }
    const [cursors, counts, meta] = await Promise.all([
      db.all<{ shard: number; last_event_id: number; last_block_ts: number; covered_since: number }>('SELECT * FROM ingest_cursor'),
      indexCounts(db),
      db.all<{ rev: number }>('SELECT rev FROM index_meta WHERE k = 1'),
    ])
    const shards = await Promise.all(DATA_SHARDS.map(async s => ({
      shard: s,
      cursor: cursors.find(r => r.shard === s) ?? null,
      object: await c.env.INGEST.get(c.env.INGEST.idFromName(`shard-${s}`)).status(),
    })))
    const now = Math.floor(Date.now() / 1000)
    return c.json({
      now,
      rev: meta[0]?.rev ?? 0,
      index: counts,
      shards: shards.map(s => ({ ...s, lagSeconds: s.cursor ? now - s.cursor.last_block_ts : null })),
    }, 200, { 'cache-control': 'no-store' })
  })

  return app
}

/** Index sizes, counted at most once a minute per isolate: they're for a person reading the status page. */
let counted: { at: number; value: Promise<{ casts: number; users: number; channels: number } | undefined> } | null = null
const indexCounts = (db: D1Sql) => {
  const at = Math.floor(systemClock.now() / 60)
  if (!counted || counted.at !== at) {
    counted = {
      at,
      value: db.all<{ casts: number; users: number; channels: number }>(
        'SELECT (SELECT count(*) FROM casts) AS casts, (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM channels) AS channels',
      ).then(r => r[0], (e: unknown) => { counted = null; throw e }),
    }
  }
  return counted.value
}

export const ensureIngestion = async (env: Env) => {
  await Promise.all(DATA_SHARDS.map(s => env.INGEST.get(env.INGEST.idFromName(`shard-${s}`)).ensure(s)))
}
