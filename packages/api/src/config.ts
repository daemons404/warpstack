import { parseSessionOrigin } from '@warpstack/protocol'
import { z } from 'zod'
import { API_LIMITS } from './core/limits.ts'
import type { Env } from './env.ts'

// Config is a schema: a bad deployment fails with a message that
// names the fix, never on the first request that happens to need the missing value.

const secret = (name: string) => z.string().min(32, `${name} must be at least 32 characters; generate one with \`openssl rand -hex 32\``)

export const Config = z.object({
  snapchain: z.object({
    /** One node, or a pool tried in this order. */
    nodes: z.array(z.url({ protocol: /^https?$/, error: 'SNAPCHAIN_URL must be an http(s) URL, or several separated by commas, e.g. https://snap.farcaster.xyz:3381' }))
      .min(1, 'Set SNAPCHAIN_URL to your Snapchain node, e.g. https://snap.farcaster.xyz:3381')
      .max(8, 'SNAPCHAIN_URL lists at most 8 nodes'),
    accessToken: z.string().regex(/^[^:]+:.+$/, 'SNAPCHAIN_ACCESS_TOKEN must be `client-id:client-secret`').optional(),
  }),
  channelRegistry: z.enum(['farcaster', 'seeded'], { error: 'CHANNEL_REGISTRY must be `farcaster` or `seeded`' }),
  readOnly: z.boolean(),
  backfillHours: z.number({ error: 'INGEST_BACKFILL_HOURS must be a number of hours' }).positive().max(24 * 30).optional(),
  /** How long the cast index keeps casts. D1's 10 GB bounds it: about 1 GB at 28 days and ten times today's volume. */
  retentionDays: z.number({ error: 'RETENTION_DAYS must be a number of days' }).int().min(1, 'RETENTION_DAYS must be at least 1').max(90, 'RETENTION_DAYS is at most 90: D1 holds 10 GB'),
  cursorKey: secret('CURSOR_MAC_KEY'),
  sessionKey: secret('SESSION_MAC_KEY'),
  origin: z.string().refine(o => parseSessionOrigin(o).ok,
    'CANONICAL_ORIGIN must be the origin the app signs in to: https://host[:port], or http://localhost[:port] in development, with no path'),
  appFid: z.number({ error: 'APP_FID must be a FID' }).int().positive().optional(),
  acceptKeysFrom: z.enum(['any', 'appFid'], { error: 'ACCEPT_SESSION_KEYS_FROM must be `any` or `appFid`' }),
  access: z.enum(['private', 'public'], { error: 'ACCESS must be `private` or `public`' }),
  allowedFids: z.array(z.number().int().positive(), { error: 'ALLOWED_FIDS must be FIDs separated by commas, e.g. `1234, 42`' }).max(1_000),
  mediaKey: secret('MEDIA_KEY').optional(),
  mediaOrigin: z.string().refine(o => {
    try {
      const u = new URL(o)
      return u.protocol === 'https:' && u.origin === o
    } catch {
      return false
    }
  }, 'MEDIA_ORIGIN must be an https origin with no path, e.g. https://warpstack-media.you.workers.dev').optional(),
  /** Video uploads, on the account's Cloudflare Stream; both or neither. */
  stream: z.object({
    account: z.string().regex(/^[0-9a-f]{32}$/, 'STREAM_ACCOUNT_ID must be a Cloudflare account ID (32 hex characters)'),
    token: z.string().min(20, 'STREAM_API_TOKEN looks too short to be a Cloudflare API token'),
  }).optional(),
}).refine(c => c.acceptKeysFrom !== 'appFid' || c.appFid !== undefined, 'ACCEPT_SESSION_KEYS_FROM=appFid needs APP_FID')
  // A private deployment must say who is allowed; nothing defaults to "everyone".
  .refine(c => c.access === 'public' || c.allowedFids.length > 0 || c.appFid !== undefined,
    'Say who may use this deployment: ALLOWED_FIDS (e.g. your FID), APP_FID (keys your app FID requested), or ACCESS=public (anyone)')
  .refine(c => c.access === 'public' || !c.mediaOrigin || c.mediaKey !== undefined,
    'A private deployment with MEDIA_ORIGIN needs MEDIA_KEY (shared with the media Worker); generate one with `openssl rand -hex 32`')
  // Images are served from their own origin so an image can never run as a page on the API's.
  .refine(c => !c.mediaOrigin || new URL(c.mediaOrigin).host !== new URL(c.origin).host,
    'MEDIA_ORIGIN must be a different host from CANONICAL_ORIGIN')
export type Config = z.infer<typeof Config>

export class ConfigError extends Error {}

/** Who may open a session: everyone, listed FIDs, or keys the app FID requested. */
export type Admission = { public: boolean; allowed: ReadonlySet<number>; appFid?: number | undefined }
export const admissionOf = (c: Config): Admission => ({ public: c.access === 'public', allowed: new Set(c.allowedFids), appFid: c.appFid })
export const admits = (a: Admission, fid: number, requestFid?: number): boolean =>
  a.public || a.allowed.has(fid) || (a.appFid !== undefined && requestFid === a.appFid)

export const parseConfig = (env: Env): Config => {
  const r = Config.safeParse({
    snapchain: { nodes: (env.SNAPCHAIN_URL ?? '').split(',').map(u => u.trim()).filter(Boolean), accessToken: env.SNAPCHAIN_ACCESS_TOKEN || undefined },
    channelRegistry: env.CHANNEL_REGISTRY || 'farcaster',
    readOnly: env.READ_ONLY === 'true',
    backfillHours: env.INGEST_BACKFILL_HOURS ? Number(env.INGEST_BACKFILL_HOURS) : undefined,
    retentionDays: env.RETENTION_DAYS ? Number(env.RETENTION_DAYS) : API_LIMITS.RETENTION_DAYS,
    cursorKey: env.CURSOR_MAC_KEY ?? '',
    sessionKey: env.SESSION_MAC_KEY ?? '',
    origin: env.CANONICAL_ORIGIN ?? '',
    appFid: env.APP_FID ? Number(env.APP_FID) : undefined,
    acceptKeysFrom: env.ACCEPT_SESSION_KEYS_FROM || 'any',
    access: env.ACCESS || 'private',
    allowedFids: (env.ALLOWED_FIDS ?? '').split(',').map(x => x.trim()).filter(Boolean).map(x => (/^[0-9]{1,12}$/.test(x) ? Number(x) : NaN)),
    mediaKey: env.MEDIA_KEY || undefined,
    mediaOrigin: env.MEDIA_ORIGIN || undefined,
    stream: env.STREAM_ACCOUNT_ID || env.STREAM_API_TOKEN ? { account: env.STREAM_ACCOUNT_ID ?? '', token: env.STREAM_API_TOKEN ?? '' } : undefined,
  })
  if (!r.success) throw new ConfigError(`Invalid Worker config: ${r.error.issues.map(i => i.message).join('; ')}`)
  return r.data
}
