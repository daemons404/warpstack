import { EmbedMetadata } from '@warpstack/contract'
import { describe, expect, it } from 'vitest'
import { sniffImage } from '../src/adapters/fetchers/index.ts'
import { IndexReader } from '../src/adapters/index-reader.ts'
import { userSummaryOf } from '../src/core/present.ts'
import { HmacMac } from '../src/adapters/hmac.ts'
import { IndexMaintenance } from '../src/adapters/index-maintenance.ts'
import { makeMediaToken, mediaTokenValid } from '../src/core/media-token.ts'
import { FakeSnapchain } from '../src/adapters/snapchain-fake.ts'
import { Reads } from '../src/reads.ts'
import { AVATAR_SIZE, avatarKey, Media, RETRY_FAILED_SECONDS, sha256Hex, TransientError, type MediaDeps } from '../src/media.ts'
import mediaWorker from '../src/media-worker.ts'
import { MemorySql } from './sqlite.ts'

// Images: nothing reaches a phone unless Cloudflare re-encoded it.

const bytes = (...parts: (number[] | string | Uint8Array)[]) => Uint8Array.from(parts.flatMap(p =>
  typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : [...p]))
const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, n >>> 16]
const le32 = (n: number) => [...le24(n), n >>> 24]
const chunk = (type: string, data: number[]) => bytes(be32(data.length), type, data, [0, 0, 0, 0])
const pngOf = (w: number, h: number) =>
  bytes('\x89PNG\r\n\x1a\n', chunk('IHDR', [...be32(w), ...be32(h), 8, 6, 0, 0, 0]), chunk('IEND', []))
const webpOf = (w: number, h: number, exif = false) => {
  const body = bytes('WEBP', bytes('VP8X', le32(10), [exif ? 0x08 : 0, 0, 0, 0], le24(w - 1), le24(h - 1)), exif ? bytes('EXIF', le32(2), [0, 0]) : new Uint8Array())
  return bytes('RIFF', le32(body.length), body)
}

const T = 1_800_000_000

type Served = Record<string, { status?: number; type?: string; body: Uint8Array | string; location?: string } | 'network'>

const world = (served: Served, opts: { images?: 'webp' | 'webp-exif' | 'png' | 'throws' | 'none'; admit?: boolean } = {}) => {
  const db = new MemorySql()
  const fetched: string[] = []
  const stored = new Map<string, { bytes: Uint8Array; contentType?: string | undefined; sha?: string | undefined }>()
  const transforms: unknown[] = []
  let now = T
  const accepts: string[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    fetched.push(url)
    accepts.push(new Headers(init?.headers).get('accept') ?? '')
    const r = served[url]
    if (!r) return new Response('nope', { status: 404 })
    if (r === 'network') throw new TypeError('network down')
    const headers: Record<string, string> = { 'content-type': r.type ?? 'application/octet-stream' }
    if (r.location) headers.location = r.location
    return new Response(r.body, { status: r.status ?? 200, headers })
  }) as typeof fetch
  const images = {
    // Plays the encoder: the output has the transform's size, in the input's aspect ratio.
    input: (input: ReadableStream) => {
      let tr: { width: number; height?: number | undefined } = { width: 0 }
      const t = {
        transform: (x: { width: number; height?: number }) => (transforms.push(x), (tr = x), t),
        output: async (o: { format: string }) => {
          if (opts.images === 'throws') throw new Error('9422: limit')
          transforms.push(o)
          const src = sniffImage(new Uint8Array(await new Response(input).arrayBuffer()))!
          const w = Math.min(tr.width, src.width)
          const h = tr.height ?? Math.round(src.height * w / src.width)
          const out = opts.images === 'png' ? pngOf(w, h) : opts.images === 'webp-exif' ? webpOf(w, h, true) : webpOf(w, h)
          return { image: () => new Response(out).body!, contentType: () => o.format, response: () => new Response(out) }
        },
      }
      return t
    },
  } as unknown as ImagesBinding
  const bucket = {
    put: async (key: string, value: Uint8Array, o?: R2PutOptions) => {
      stored.set(key, { bytes: value, contentType: (o?.httpMetadata as R2HTTPMetadata | undefined)?.contentType, sha: o?.customMetadata?.sha256 })
      return null
    },
    get: async (key: string) => {
      const s = stored.get(key)
      return s ? { body: new Response(s.bytes).body, size: s.bytes.length, httpEtag: '"e"' } : null
    },
  } as unknown as R2Bucket
  const deps: MediaDeps = {
    db,
    clock: { now: () => now as never },
    policy: { deny: ['warpstack.you.workers.dev', 'media.example.com', 'snap.farcaster.xyz'] },
    bucket,
    images: opts.images === 'none' ? undefined : images,
    admit: async () => opts.admit ?? true,
    fetcher,
    mediaOrigin: 'https://media.example.com',
  }
  return { db, deps, media: new Media(deps), fetched, accepts, stored, transforms, bucket, advance: (s: number) => { now += s } }
}

describe('avatars', () => {
  it('fetches, re-encodes and stores an avatar once, as WebP at the avatar size', async () => {
    const w = world({ 'https://img.example.org/me.png': { type: 'image/png', body: pngOf(400, 400) } })
    const s = await w.media.store('https://img.example.org/me.png', 'avatar')
    const key = `a/${await sha256Hex('https://img.example.org/me.png')}/${AVATAR_SIZE}`
    expect(s).toEqual({ key, width: AVATAR_SIZE, height: AVATAR_SIZE })
    expect(w.transforms[0]).toEqual({ width: AVATAR_SIZE, height: AVATAR_SIZE, fit: 'cover' })
    // The stored bytes are the encoder's output, and their source's hash is kept for takedowns.
    const obj = w.stored.get(key)!
    expect(obj.contentType).toBe('image/webp')
    expect(new TextDecoder().decode(obj.bytes.subarray(8, 12))).toBe('WEBP')
    expect(obj.sha).toBe(await sha256Hex(pngOf(400, 400)))
    // A second request reads the row and fetches nothing.
    expect(await w.media.store('https://img.example.org/me.png', 'avatar')).toEqual(s)
    expect(w.fetched).toHaveLength(1)
  })

  it('stores nothing without the Images binding: never a pass-through', async () => {
    const w = world({ 'https://img.example.org/me.png': { type: 'image/png', body: pngOf(400, 400) } }, { images: 'none' })
    expect(w.media.enabled).toBe(false)
    expect(await w.media.store('https://img.example.org/me.png', 'avatar')).toBeNull()
    await w.media.storeAvatars(['https://img.example.org/me.png'])
    expect(w.fetched).toHaveLength(0)
    expect(w.stored.size).toBe(0)
  })

  it('stores nothing when the re-encode fails or returns anything but WebP', async () => {
    for (const images of ['throws', 'png'] as const) {
      const w = world({ 'https://img.example.org/me.png': { type: 'image/png', body: pngOf(400, 400) } }, { images })
      expect(await w.media.store('https://img.example.org/me.png', 'avatar')).toBeNull()
      expect(w.stored.size).toBe(0)
    }
  })

  it('refuses what is not an image, whatever the headers say', async () => {
    const w = world({ 'https://img.example.org/me.png': { type: 'image/png', body: '<svg onload="alert(1)"/>' } })
    expect(await w.media.store('https://img.example.org/me.png', 'avatar')).toBeNull()
    expect(w.transforms).toHaveLength(0)
    expect(w.stored.size).toBe(0)
  })

  it('remembers a failure and tries again only after a day', async () => {
    const w = world({ 'https://img.example.org/me.png': { status: 404, body: 'gone' } })
    expect(await w.media.store('https://img.example.org/me.png', 'avatar')).toBeNull()
    expect(await w.media.store('https://img.example.org/me.png', 'avatar')).toBeNull()
    expect(w.fetched).toHaveLength(1)
    w.advance(RETRY_FAILED_SECONDS)
    await w.media.store('https://img.example.org/me.png', 'avatar')
    expect(w.fetched).toHaveLength(2)
  })

  it('does not remember being busy or offline as a failure', async () => {
    const w = world({ 'https://img.example.org/me.png': 'network' })
    await expect(w.media.store('https://img.example.org/me.png', 'avatar')).rejects.toBeInstanceOf(TransientError)
    const limited = world({ 'https://img.example.org/me.png': { type: 'image/png', body: pngOf(9, 9) } }, { admit: false })
    await expect(limited.media.store('https://img.example.org/me.png', 'avatar')).rejects.toBeInstanceOf(TransientError)
    expect(limited.fetched).toHaveLength(0)
    expect(await w.db.all('SELECT * FROM media_sources')).toEqual([])
  })

  it('honours takedowns by URL before fetching, and by content after', async () => {
    const byUrl = world({ 'https://img.example.org/me.png': { type: 'image/png', body: pngOf(9, 9) } })
    await byUrl.db.batch([{ sql: "INSERT INTO takedowns (key, kind, ts) VALUES (?1, 'url', 0)", params: ['https://img.example.org/me.png'] }])
    expect(await byUrl.media.store('https://img.example.org/me.png', 'avatar')).toBeNull()
    expect(byUrl.fetched).toHaveLength(0)

    // The same bytes under a new URL stay down.
    const byContent = world({ 'https://elsewhere.example.org/copy.png': { type: 'image/png', body: pngOf(9, 9) } })
    await byContent.db.batch([{ sql: "INSERT INTO takedowns (key, kind, ts) VALUES (?1, 'content', 0)", params: [await sha256Hex(pngOf(9, 9))] }])
    expect(await byContent.media.store('https://elsewhere.example.org/copy.png', 'avatar')).toBeNull()
    expect(byContent.stored.size).toBe(0)
  })

  it('never fetches our own hosts or private addresses', async () => {
    const w = world({})
    for (const src of ['https://media.example.com/x.png', 'https://warpstack.you.workers.dev/x.png', 'https://127.0.0.1/x.png', 'http://img.example.org/x.png']) {
      expect(await w.media.store(src, 'avatar')).toBeNull()
    }
    expect(w.fetched).toHaveLength(0)
  })

  it('names an avatar in profiles only once it is stored', async () => {
    const w = world({ 'https://img.example.org/me.png': { type: 'image/png', body: pngOf(400, 400) } })
    await w.db.batch([{ sql: "INSERT INTO users (fid, username, pfp, complete, updated_ts) VALUES (7, 'seven', 'https://img.example.org/me.png', 1, 0)", params: [] }])
    const reader = new IndexReader(w.db)
    let [row] = await reader.usersByFid([7])
    expect(userSummaryOf(7, row)).not.toHaveProperty('pfp')
    const s = await w.media.store('https://img.example.org/me.png', 'avatar')
    ;[row] = await reader.usersByFid([7])
    expect(userSummaryOf(7, row).pfp).toBe(s!.key)
    // A new avatar URL drops the old key until the new one is stored.
    await w.db.batch([{ sql: "UPDATE users SET pfp = 'https://img.example.org/new.png' WHERE fid = 7", params: [] }])
    ;[row] = await reader.usersByFid([7])
    expect(userSummaryOf(7, row)).not.toHaveProperty('pfp')
  })
})

describe('avatars in responses', () => {
  const setup = async (status?: 'ok' | 'failed', ts = T) => {
    const db = new MemorySql()
    const src = 'https://img.example.org/me.png'
    await db.batch([{ sql: "INSERT INTO users (fid, username, pfp, complete, verified, counts_ts, updated_ts) VALUES (7, 'seven', ?1, 1, '[]', ?2, 0)", params: [src, T] }])
    if (status) await db.batch([{ sql: "INSERT INTO media_sources (src, kind, status, key, width, height, ts) VALUES (?1, 'avatar', ?2, ?3, 144, 144, ?4)", params: [src, status, status === 'ok' ? await avatarKey(src) : null, ts] }])
    const asked: string[][] = []
    const reads = new Reads(new IndexReader(db), new IndexMaintenance(db), new FakeSnapchain(), new HmacMac('k'.repeat(32)), { now: () => T as never }, srcs => asked.push(srcs))
    return { reads, asked, src }
  }
  const pfpOf = async (reads: Reads) => {
    const r = await reads.usersBulk([7 as never])
    return r.ok ? r.value.users[0]!.pfp : 'error'
  }

  it('names a new avatar right away, under the key it will be stored at, and asks for it', async () => {
    const { reads, asked, src } = await setup()
    expect(await pfpOf(reads)).toBe(await avatarKey(src))
    expect(asked).toEqual([[src]])
  })

  it('names a stored avatar without asking again', async () => {
    const { reads, asked, src } = await setup('ok')
    expect(await pfpOf(reads)).toBe(await avatarKey(src))
    expect(asked).toEqual([])
  })

  it('names nothing for an avatar that failed, until it is retried', async () => {
    const fresh = await setup('failed')
    expect(await pfpOf(fresh.reads)).toBeUndefined()
    expect(fresh.asked).toEqual([])
    const old = await setup('failed', T - RETRY_FAILED_SECONDS)
    expect(await pfpOf(old.reads)).toBe(await avatarKey(old.src))
    expect(old.asked).toEqual([[old.src]])
  })
})

describe('uploads', () => {
  it('stores a posted image once, re-encoded, under the hash of its bytes, and names its public URL', async () => {
    const w = world({})
    const r = await w.media.storeUpload(pngOf(2000, 1000), 7)
    const sha = await sha256Hex(pngOf(2000, 1000))
    expect(r).toEqual({ ok: true, value: { key: `u/${sha}/1080`, width: 1080, height: 540, url: `https://media.example.com/img/u/${sha}/1080` } })
    expect(w.stored.get(`u/${sha}/1080`)!.contentType).toBe('image/webp')
    // The same bytes again: no second transformation.
    expect(await w.media.storeUpload(pngOf(2000, 1000), 8)).toEqual(r)
    expect(w.transforms.filter(t => t && typeof t === 'object' && 'format' in t)).toHaveLength(1)
    expect(w.fetched).toHaveLength(0)
  })

  it('answers its own embed from the uploads table, without fetching our own origin', async () => {
    const w = world({})
    const r = await w.media.storeUpload(pngOf(2000, 1000), 7)
    if (!r.ok) throw new Error('upload failed')
    expect(await w.media.embed(r.value.url)).toEqual({ kind: 'image', media: r.value.key, width: 1080, height: 540 })
    expect(w.fetched).toHaveLength(0)
  })

  it('accepts a phone JPEG with its EXIF block: only the re-encoded result is stored', async () => {
    const w = world({})
    const exif = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 16, ...[...'Exif\0\0MM\0*\0\0\0\0'].map(c => c.charCodeAt(0)),
      0xff, 0xc0, 0, 17, 8, 0, 100, 0, 100, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9])
    const r = await w.media.storeUpload(exif, 7)
    expect(r.ok).toBe(true)
    const stored = [...w.stored.values()][0]!.bytes
    expect(new TextDecoder().decode(stored.subarray(8, 12))).toBe('WEBP')
  })

  it('stores nothing whose re-encoded bytes still carry metadata, for any kind of image', async () => {
    const w = world({ 'https://img.example.org/me.png': { type: 'image/png', body: pngOf(400, 400) } }, { images: 'webp-exif' })
    expect(await w.media.store('https://img.example.org/me.png', 'avatar')).toBeNull()
    expect(await w.media.storeUpload(pngOf(400, 400), 7)).toMatchObject({ ok: false, error: { why: 're-encode kept metadata' } })
    expect(w.stored.size).toBe(0)
  })

  it('refuses non-images, takedowns, and everything when images are off', async () => {
    const w = world({})
    expect((await w.media.storeUpload(new TextEncoder().encode('<svg/>'), 7)).ok).toBe(false)
    await w.db.batch([{ sql: "INSERT INTO takedowns (key, kind, ts) VALUES (?1, 'content', 0)", params: [await sha256Hex(pngOf(9, 9))] }])
    expect((await w.media.storeUpload(pngOf(9, 9), 7)).ok).toBe(false)
    expect((await world({}, { images: 'none' }).media.storeUpload(pngOf(9, 9), 7)).ok).toBe(false)
    expect(w.stored.size).toBe(0)
  })
})

describe('channel images in responses', () => {
  const img = (i: number) => `https://img.example.org/ch${i}.png`
  const setup = async (stored?: number) => {
    const db = new MemorySql()
    await db.batch([{ sql: "INSERT INTO channels (key, url, name, image, moderators, updated_ts) VALUES ('base', 'https://base.org', 'Base', ?1, '[]', 0)", params: [img(0)] }])
    if (stored !== undefined) await db.batch([{ sql: "INSERT INTO media_sources (src, kind, status, key, width, height, ts) VALUES (?1, 'avatar', 'ok', ?2, 144, 144, ?3)", params: [img(stored), await avatarKey(img(stored)), T] }])
    const asked: string[][] = []
    const reads = new Reads(new IndexReader(db), new IndexMaintenance(db), new FakeSnapchain(), new HmacMac('k'.repeat(32)), { now: () => T as never }, srcs => asked.push(srcs))
    return { reads, asked }
  }

  it('names a channel image right away and asks for it; a stored one is named without asking', async () => {
    const fresh = await setup()
    const r = await fresh.reads.channel('base')
    expect(r.ok && r.value.channel.image).toBe(await avatarKey(img(0)))
    expect(fresh.asked).toEqual([[img(0)]])
    const stored = await setup(0)
    const s2 = await stored.reads.channel('base')
    expect(s2.ok && s2.value.channel.image).toBe(await avatarKey(img(0)))
    expect(stored.asked).toEqual([])
  })

  it('asks for more images at once for an import of followed channels than for a page', async () => {
    const { reads, asked } = await setup()
    const rows = Array.from({ length: 30 }, (_, i) => ({ key: `c${i}`, url: `https://c${i}.org`, name: `C${i}`, description: null, image: img(i), moderators: [], follower_count: null }))
    const channels = await reads.presentChannels(rows)
    expect(asked[0]).toHaveLength(24)
    expect(channels.filter(c => c.image)).toHaveLength(24)
  })
})

describe('embeds', () => {
  const page = `<html><head>
    <meta property="og:title" content="A &amp; B">
    <meta property="og:site_name" content="paypal.com">
    <meta property="og:description" content="&#x202E;txt.exe">
    <meta property="og:image" content="/card.png">
  </head><body>hi</body></html>`

  it('reads a page into a link card, with its preview image re-encoded and the real domain', async () => {
    const w = world({
      'https://blog.example.org/post': { status: 302, body: '', location: 'https://cdn.example.net/post' },
      'https://cdn.example.net/post': { type: 'text/html; charset=utf-8', body: page },
      'https://cdn.example.net/card.png': { type: 'image/png', body: pngOf(1200, 630) },
    })
    const m = await w.media.embed('https://blog.example.org/post')
    expect(EmbedMetadata.parse(m)).toEqual(m)
    expect(m).toMatchObject({ kind: 'link', domain: 'blog.example.org', title: 'A & B', site: 'paypal.com', description: 'txt.exe' })
    expect('image' in m && m.image).toMatchObject({ width: 1080, height: 567 })
    // Cached: the next view fetches nothing.
    const before = w.fetched.length
    expect(await w.media.embed('https://blog.example.org/post')).toEqual(m)
    expect(w.fetched).toHaveLength(before)
  })

  it('stores an image embed, by its bytes', async () => {
    const w = world({ 'https://i.example.org/photo': { type: 'application/octet-stream', body: pngOf(2000, 1000) } })
    expect(await w.media.embed('https://i.example.org/photo')).toMatchObject({ kind: 'image', width: 1080, height: 540 })
    expect(w.transforms[0]).toEqual({ width: 1080, fit: 'scale-down' })
  })

  it('is unknown for anything else, and without the binding an image is just a link', async () => {
    const w = world({ 'https://x.example.org/f.zip': { type: 'application/zip', body: 'PK' } })
    expect(await w.media.embed('https://x.example.org/f.zip')).toEqual({ kind: 'unknown', domain: 'x.example.org' })
    const off = world({ 'https://i.example.org/p.png': { type: 'image/png', body: pngOf(10, 10) } }, { images: 'none' })
    expect(await off.media.embed('https://i.example.org/p.png')).toEqual({ kind: 'unknown', domain: 'i.example.org' })
  })

  it('asks for a URL named like an image as an image: Giphy and Tenor send pages to browsers', async () => {
    const gif = 'https://media.giphy.com/media/abc/giphy.gif'
    const w = world({ [gif]: { type: 'image/png', body: pngOf(480, 270) } })
    expect(await w.media.embed(gif)).toMatchObject({ kind: 'image', width: 480, height: 270 })
    expect(w.accepts[0]).toMatch(/^image\//)
    const page = world({ 'https://blog.example.org/post': { type: 'text/html', body: '<title>t</title>' } })
    await page.media.embed('https://blog.example.org/post')
    expect(page.accepts[0]).toMatch(/^text\/html/)
  })

  it("describes a YouTube link from YouTube's oEmbed answer, with its thumbnail re-encoded", async () => {
    const video = 'https://www.youtube.com/watch?v=abc123'
    const oembed = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(video)}`
    const w = world({
      [oembed]: { type: 'application/json', body: JSON.stringify({ title: 'A song &amp; a day', author_name: 'Jonathan', thumbnail_url: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg' }) },
      'https://i.ytimg.com/vi/abc123/hqdefault.jpg': { type: 'image/png', body: pngOf(480, 360) },
    })
    const m = await w.media.embed(video)
    expect(EmbedMetadata.parse(m)).toEqual(m)
    expect(m).toMatchObject({ kind: 'link', domain: 'www.youtube.com', title: 'A song & a day', description: 'Jonathan', site: 'YouTube', image: { width: 480, height: 360 } })
    expect(w.fetched).not.toContain(video)
    // A thumbnail anywhere but YouTube's image host isn't fetched.
    const odd = world({ [oembed]: { type: 'application/json', body: JSON.stringify({ title: 't', thumbnail_url: 'https://evil.example.org/x.png' }) } })
    expect(await odd.media.embed(video)).not.toHaveProperty('image')
    expect(odd.fetched).not.toContain('https://evil.example.org/x.png')
    // Garbage is a failure, remembered like any other.
    const bad = world({ [oembed]: { type: 'application/json', body: 'not json' } })
    expect(await bad.media.embed(video)).toEqual({ kind: 'unknown', domain: 'www.youtube.com' })
  })

  it("throws, rather than caching, when it can't say right now", async () => {
    const w = world({ 'https://down.example.org/': 'network' })
    await expect(w.media.embed('https://down.example.org/')).rejects.toBeInstanceOf(TransientError)
    expect(await w.db.all('SELECT * FROM embed_meta')).toEqual([])
  })
})

describe('a private media origin', () => {
  const key = `a/${'0'.repeat(64)}/144`
  const MEDIA_KEY = 'm'.repeat(32)
  const objects = { [key]: webpOf(144, 144) }
  const env = (extra: { MEDIA_KEY?: string } = { MEDIA_KEY }) => ({
    MEDIA: { get: async (k: string) => (objects[k] ? { body: new Response(objects[k]).body, size: objects[k].length, httpEtag: '"e"' } : null) } as unknown as R2Bucket,
    ...extra,
  })
  const get = (q: string, e = env()) => mediaWorker.fetch(new Request(`https://media.example.com/img/${key}${q}`), e)

  it('opens images only with a valid, unexpired token, and keeps them out of shared caches', async () => {
    const now = Math.floor(Date.now() / 1_000)
    const t = await makeMediaToken(new HmacMac(MEDIA_KEY), now)
    const res = await get(`?t=${t.token}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('private, max-age=86400')
    expect((await get('')).status).toBe(403)
    expect((await get('?t=garbage')).status).toBe(403)
    const forged = await makeMediaToken(new HmacMac('x'.repeat(32)), now)
    expect((await get(`?t=${forged.token}`)).status).toBe(403)
    const old = await makeMediaToken(new HmacMac(MEDIA_KEY), now - 3 * 86_400)
    expect((await get(`?t=${old.token}`)).status).toBe(403)
  })

  it('serves posted images to anyone: a cast names them', async () => {
    const posted = `u/${'1'.repeat(64)}/1080`
    const e = { MEDIA: { get: async () => ({ body: new Response(webpOf(9, 9)).body, size: 9, httpEtag: '"e"' }) } as unknown as R2Bucket, MEDIA_KEY }
    const res = await mediaWorker.fetch(new Request(`https://media.example.com/img/${posted}`), e)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400')
  })

  it('serves nothing, rather than everything, without its key', async () => {
    expect((await get('', env({}))).status).toBe(503)
  })

  it('gives every user the same token for the day, so image URLs stay cacheable', async () => {
    const mac = new HmacMac(MEDIA_KEY)
    const a = await makeMediaToken(mac, 1_800_000_000)
    expect(await makeMediaToken(mac, 1_800_000_000 + 3_600)).toEqual(a)
    expect(await mediaTokenValid(mac, a.token, 1_800_000_000)).toBe(true)
  })
})

describe('media origin', () => {
  const env = (objects: Record<string, Uint8Array>, extra: { ACCESS?: string; MEDIA_KEY?: string } = { ACCESS: 'public' }) => ({
    MEDIA: { get: async (k: string) => (objects[k] ? { body: new Response(objects[k]).body, size: objects[k].length, httpEtag: '"e"' } : null) } as unknown as R2Bucket,
    ...extra,
  })
  const key = `a/${'0'.repeat(64)}/144`

  it('serves stored keys as WebP that can never run as a page', async () => {
    const res = await mediaWorker.fetch(new Request(`https://media.example.com/img/${key}`), env({ [key]: webpOf(144, 144) }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
  })

  it('is a 404 for anything not stored or not shaped like a key, and never fetches', async () => {
    // Not cached: an avatar can be named a moment before it's stored.
    expect((await mediaWorker.fetch(new Request(`https://media.example.com/img/${key}`), env({}))).headers.get('cache-control')).toBe('no-store')
    for (const path of [`/img/${key}`, '/img/https://evil.example/x.png', '/img/../secrets', `/img/u/${'0'.repeat(64)}/1080`, '/']) {
      const res = await mediaWorker.fetch(new Request(`https://media.example.com${path}`), env({}))
      expect(res.status, path).toBe(404)
    }
    expect((await mediaWorker.fetch(new Request(`https://media.example.com/img/${key}`, { method: 'POST' }), env({}))).status).toBe(405)
  })
})
