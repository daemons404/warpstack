import { EmbedMetadata, VIDEO_LIMITS } from '@warpstack/contract'
import { describe, expect, it } from 'vitest'
import { CloudflareStream } from '../src/adapters/stream.ts'
import { FAKE_STREAM_HOST, FakeVideoHost } from '../src/adapters/video-fake.ts'
import type { Media } from '../src/media.ts'
import { UPLOAD_WINDOW_SECONDS, Videos } from '../src/videos.ts'
import { MemorySql } from './sqlite.ts'

// Videos: uploads are optional and counted, and a video plays only from Farcaster's servers or
// this deployment's own uploads.

const T = 1_800_000_000

const setup = (opts: { host?: boolean; images?: boolean } = {}) => {
  const db = new MemorySql()
  let now = T
  const host = new FakeVideoHost()
  const stored: string[] = []
  const media = {
    enabled: opts.images ?? true,
    store: async (src: string) => {
      stored.push(src)
      return { key: 'p/' + 'a'.repeat(64) + '/640', width: 640, height: 360 }
    },
  } as unknown as Media
  const videos = new Videos({ db, clock: { now: () => now as never }, host: opts.host === false ? undefined : host, media })
  return { db, host, videos, stored, advance: (s: number) => { now += s } }
}

describe('video uploads', () => {
  it('are off without a video host, and say so', async () => {
    const { videos } = setup({ host: false })
    expect(videos.enabled).toBe(false)
    expect(await videos.start(1)).toEqual({ ok: false, error: { kind: 'off' } })
    expect(await videos.status('0'.repeat(32), 1)).toEqual({ ok: false, error: { kind: 'off' } })
  })

  it('hand out a one-time URL capped at the longest video, expiring soon', async () => {
    const { videos, host } = setup()
    const r = await videos.start(42)
    if (!r.ok) throw new Error('expected an upload')
    const v = host.videos.get(r.value.id)!
    expect(v.maxSeconds).toBe(VIDEO_LIMITS.maxSeconds)
    expect(v.creator).toBe('fid:42')
    expect(v.expiresAt).toBe(T + UPLOAD_WINDOW_SECONDS)
  })

  it('are counted per member per day, then per deployment', async () => {
    const { videos, advance } = setup()
    for (let i = 0; i < VIDEO_LIMITS.perFidPerDay; i++) expect((await videos.start(1)).ok).toBe(true)
    const over = await videos.start(1)
    expect(over.ok || over.error.kind).toBe('limit')
    // Others still can, until the deployment's day is used up.
    let fid = 2
    for (let started = VIDEO_LIMITS.perFidPerDay; started < VIDEO_LIMITS.perDeploymentPerDay; started++) {
      expect((await videos.start(fid)).ok).toBe(true)
      if ((started + 1) % VIDEO_LIMITS.perFidPerDay === 0) fid++
    }
    const full = await videos.start(999)
    expect(full.ok || full.error.kind).toBe('limit')
    // A day later the counts are fresh.
    advance(86_401)
    expect((await videos.start(1)).ok).toBe(true)
  })

  it('report processing, then ready with the playlist, storing the poster through the image pipeline', async () => {
    const { videos, host, stored } = setup()
    const r = await videos.start(7)
    if (!r.ok) throw new Error('expected an upload')
    expect(await videos.status(r.value.id, 7)).toEqual({ ok: true, value: { state: 'processing' } })
    const hls = host.finish(r.value.id, { width: 1080, height: 1920, duration: 12.5 })
    expect(await videos.status(r.value.id, 7)).toEqual({ ok: true, value: { state: 'ready', url: hls } })
    expect(stored).toEqual([`https://${FAKE_STREAM_HOST}/${r.value.id}/thumbnails/thumbnail.jpg`])
    // Once ready, it's answered from the table without asking Stream again.
    host.down = true
    expect(await videos.status(r.value.id, 7)).toEqual({ ok: true, value: { state: 'ready', url: hls } })
  })

  it('only tell the member who started an upload about it', async () => {
    const { videos } = setup()
    const r = await videos.start(7)
    if (!r.ok) throw new Error('expected an upload')
    expect(await videos.status(r.value.id, 8)).toEqual({ ok: false, error: { kind: 'not_found' } })
  })

  it('report a failure in Stream\'s words', async () => {
    const { videos, host } = setup()
    const r = await videos.start(7)
    if (!r.ok) throw new Error('expected an upload')
    host.fail(r.value.id, 'The video is longer than allowed')
    expect(await videos.status(r.value.id, 7)).toEqual({ ok: true, value: { state: 'failed', reason: 'The video is longer than allowed' } })
  })

  it('say Stream is unavailable rather than counting an upload that never started', async () => {
    const { videos, host, db } = setup()
    host.down = true
    const r = await videos.start(7)
    expect(r.ok || r.error.kind).toBe('upstream')
    expect(await db.all('SELECT * FROM videos')).toEqual([])
  })
})

describe('which videos play', () => {
  it('Farcaster\'s own video servers, without a fetch', async () => {
    const { videos } = setup({ host: false })
    for (const url of ['https://stream.warpcast.com/v1/video/abc.m3u8', 'https://stream.farcaster.xyz/v1/video/abc.m3u8']) {
      const v = await videos.embed(url)
      expect(v).toEqual({ kind: 'video', url, domain: new URL(url).host })
      expect(EmbedMetadata.parse(v)).toEqual(v)
    }
  })

  it('this deployment\'s own uploads, with their size and poster, once ready', async () => {
    const { videos, host } = setup()
    const r = await videos.start(7)
    if (!r.ok) throw new Error('expected an upload')
    const hls = host.finish(r.value.id, { width: 1080, height: 1920, duration: 12.5 })
    expect(await videos.embed(hls)).toBeNull()
    await videos.status(r.value.id, 7)
    const v = await videos.embed(hls)
    expect(v).toEqual({ kind: 'video', url: hls, domain: FAKE_STREAM_HOST, width: 1080, height: 1920, duration: 12.5, poster: { media: 'p/' + 'a'.repeat(64) + '/640', width: 640, height: 360 } })
    expect(EmbedMetadata.parse(v)).toEqual(v)
  })

  it('nothing else: another Stream customer, other hosts, odd ports or credentials', async () => {
    const { videos } = setup()
    for (const url of [
      'https://customer-stranger.cloudflarestream.com/0123/manifest/video.m3u8',
      'https://evil.example/video.m3u8',
      'https://example.com/clip.mp4',
      'http://stream.warpcast.com/v1/video/abc.m3u8',
      'https://stream.warpcast.com:8443/v1/video/abc.m3u8',
      'https://user:pass@stream.warpcast.com/v1/video/abc.m3u8',
      'https://stream.warpcast.com/v1/video/abc.html',
      'not a url',
    ]) expect(await videos.embed(url)).toBeNull()
  })
})

describe('the Stream adapter', () => {
  const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const uid = 'f'.repeat(32)

  it('asks for a capped, public, expiring direct upload', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const stream = new CloudflareStream('a'.repeat(32), 'token', async (url, init) => {
      calls.push({ url: String(url), init: init! })
      return new Response(JSON.stringify({ success: true, result: { uid, uploadURL: `https://upload.videodelivery.net/${uid}` } }))
    })
    const r = await stream.createUpload({ maxSeconds: 120, creator: 'fid:1', expiresAt: T })
    expect(r).toEqual({ ok: true, value: { id: uid, uploadUrl: `https://upload.videodelivery.net/${uid}` } })
    expect(calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/stream/direct_upload`)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ maxDurationSeconds: 120, expiry: new Date(T * 1_000).toISOString(), creator: 'fid:1', requireSignedURLs: false })
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer token')
  })

  it('reads a ready video, and refuses playback on a host that isn\'t Stream\'s', async () => {
    const ready = (hls: string) => new CloudflareStream('a'.repeat(32), 't', reply(200, {
      success: true,
      result: { readyToStream: true, status: { state: 'ready' }, playback: { hls }, thumbnail: `https://customer-abc.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg`, input: { width: 720, height: 1280 }, duration: 9 },
    }))
    const good = `https://customer-abc.cloudflarestream.com/${uid}/manifest/video.m3u8`
    expect(await ready(good).status(uid)).toEqual({ ok: true, value: { state: 'ready', hls: good, thumbnail: `https://customer-abc.cloudflarestream.com/${uid}/thumbnails/thumbnail.jpg`, width: 720, height: 1280, duration: 9 } })
    expect((await ready('https://evil.example/video.m3u8').status(uid)).ok).toBe(false)
  })

  it('reads processing and failed videos, and Cloudflare\'s refusals', async () => {
    const at = (status: number, body: unknown) => new CloudflareStream('a'.repeat(32), 't', reply(status, body))
    expect(await at(200, { success: true, result: { readyToStream: false, status: { state: 'inprogress' } } }).status(uid)).toEqual({ ok: true, value: { state: 'processing' } })
    expect(await at(200, { success: true, result: { status: { state: 'error', errorReasonText: 'too long' } } }).status(uid)).toEqual({ ok: true, value: { state: 'failed', reason: 'too long' } })
    expect(await at(403, { success: false, errors: [{ message: 'Authentication error' }] }).status(uid)).toEqual({ ok: false, error: { kind: 'bad_response', detail: 'stream: Authentication error' } })
    expect((await at(503, { success: false, errors: [] }).status(uid)).ok).toBe(false)
    expect((await new CloudflareStream('a'.repeat(32), 't', async () => { throw new Error('offline') }).status(uid))).toEqual({ ok: false, error: { kind: 'unavailable', detail: 'stream: Error: offline' } })
  })
})
