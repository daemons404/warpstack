import { err, ok, type Result } from '@warpstack/protocol'
import { z } from 'zod'
import type { UpstreamError, VideoHost, VideoState } from '../ports.ts'

// Members' videos on Cloudflare Stream, on the deployment's own account. A fixed-host adapter:
// it only ever calls Cloudflare's API, with a token that can do nothing but Stream. Stream
// transcodes every upload, so viewers play files Cloudflare made, never the bytes a member sent,
// and the original isn't downloadable.

const API = 'https://api.cloudflare.com/client/v4/accounts'
const TIMEOUT_MS = 10_000

const Envelope = z.object({ success: z.boolean(), result: z.unknown().optional(), errors: z.array(z.object({ message: z.string() })).optional() })
const Created = z.object({ uid: z.string().regex(/^[0-9a-f]{32}$/), uploadURL: z.url({ protocol: /^https$/ }) })
const Details = z.object({
  readyToStream: z.boolean().optional(),
  status: z.object({ state: z.string(), errorReasonText: z.string().nullish() }).partial().nullish(),
  playback: z.object({ hls: z.url({ protocol: /^https$/ }) }).partial().nullish(),
  thumbnail: z.url({ protocol: /^https$/ }).nullish(),
  input: z.object({ width: z.number(), height: z.number() }).partial().nullish(),
  duration: z.number().nullish(),
})

/** Stream's playback hosts look like this; anything else in a reply is refused. */
export const STREAM_HOST = /^customer-[a-z0-9]{1,64}\.cloudflarestream\.com$/

const positive = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined)

export class CloudflareStream implements VideoHost {
  constructor(private readonly account: string, private readonly token: string, private readonly fetcher: typeof fetch = (...a) => fetch(...a)) {}

  private async call(path: string, init: RequestInit = {}): Promise<Result<unknown, UpstreamError>> {
    let res: Response
    try {
      res = await this.fetcher(`${API}/${this.account}/stream${path}`, {
        ...init,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      return err({ kind: 'unavailable', detail: `stream: ${String(e).slice(0, 200)}` })
    }
    const body = Envelope.safeParse(await res.json().catch(() => null))
    if (!body.success) return err({ kind: 'bad_response', detail: `stream: HTTP ${res.status}` })
    if (!res.ok || !body.data.success) {
      const why = body.data.errors?.map(e => e.message).join('; ').slice(0, 200) || `HTTP ${res.status}`
      return err({ kind: res.status >= 500 ? 'unavailable' : 'bad_response', detail: `stream: ${why}` })
    }
    return ok(body.data.result)
  }

  async createUpload(opts: { maxSeconds: number; creator: string; expiresAt: number }): Promise<Result<{ id: string; uploadUrl: string }, UpstreamError>> {
    const r = await this.call('/direct_upload', {
      method: 'POST',
      body: JSON.stringify({
        maxDurationSeconds: opts.maxSeconds,
        expiry: new Date(opts.expiresAt * 1_000).toISOString(),
        creator: opts.creator,
        // Public playback: a cast names the video, and every Farcaster app must be able to play it.
        requireSignedURLs: false,
      }),
    })
    if (!r.ok) return r
    const c = Created.safeParse(r.value)
    if (!c.success) return err({ kind: 'bad_response', detail: 'stream: unexpected direct_upload reply' })
    return ok({ id: c.data.uid, uploadUrl: c.data.uploadURL })
  }

  async status(id: string): Promise<Result<VideoState, UpstreamError>> {
    if (!/^[0-9a-f]{32}$/.test(id)) return err({ kind: 'bad_response', detail: 'stream: bad id' })
    const r = await this.call(`/${id}`)
    if (!r.ok) return r
    const d = Details.safeParse(r.value)
    if (!d.success) return err({ kind: 'bad_response', detail: 'stream: unexpected video reply' })
    const v = d.data
    if (v.status?.state === 'error') return ok({ state: 'failed', reason: (v.status.errorReasonText || 'Stream couldn\'t process the video').slice(0, 300) })
    const hls = v.playback?.hls
    if (!v.readyToStream || !hls) return ok({ state: 'processing' })
    if (!STREAM_HOST.test(new URL(hls).host)) return err({ kind: 'bad_response', detail: 'stream: playback on an unexpected host' })
    const thumb = v.thumbnail && STREAM_HOST.test(new URL(v.thumbnail).host) ? v.thumbnail : undefined
    return ok({ state: 'ready', hls, thumbnail: thumb, width: positive(v.input?.width), height: positive(v.input?.height), duration: positive(v.duration) })
  }
}
