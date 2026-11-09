import { describe, expect, it } from 'vitest'
import { checkImage, checkUrl, IMAGE_LIMITS, IMAGE_POLICY, MAX_CONCURRENT_FETCHES, readPreview, untrustedFetch, type FetchLimits } from '../src/adapters/fetchers/index.ts'

// The untrusted-content fetchers (sealed core): private and
// IP-literal addresses in every spelling, our own hostnames, redirect chains, oversized,
// compressed and slow responses, SVG and markup.

const policy = { deny: ['warpstack.example.com', 'media.warpstack.example.com', 'snap.farcaster.xyz'] }

describe('which URLs may be fetched', () => {
  it('refuses IP literals in every spelling', () => {
    for (const u of [
      'https://127.0.0.1/', 'https://10.0.0.1/', 'https://169.254.169.254/latest/meta-data', 'https://192.168.1.1/', 'https://0.0.0.0/',
      'https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/', 'https://127.1/', 'https://0x7f.0.0.1/', 'https://017700000001/',
      'https://[::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/', 'https://[fe80::1]/', 'https://[fd00::1]/', 'https://[0:0:0:0:0:0:0:1]/',
      'https://1.1.1.1/', 'https://8.8.8.8./',
    ]) expect(checkUrl(u, policy).ok, u).toBe(false)
  })

  it('refuses other schemes, ports, credentials and internal names', () => {
    for (const u of [
      'http://example.org/', 'ftp://example.org/', 'file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)', 'gopher://example.org/',
      'https://example.org:8443/', 'https://example.org:80/', 'https://user:pass@example.org/', 'https://user@example.org/',
      'https://localhost/', 'https://foo.localhost/', 'https://printer.local/', 'https://metadata.google.internal/', 'https://intranet/',
      'https://1.168.192.in-addr.arpa/', 'https://router.lan/', 'https://x.onion/', `https://${'a'.repeat(2_050)}.com/`, 'not a url',
    ]) expect(checkUrl(u, policy).ok, u).toBe(false)
  })

  it('refuses our own hosts and Workers hosts, in any case and with a trailing dot', () => {
    for (const u of [
      'https://warpstack.example.com/api/meta', 'https://WARPSTACK.example.com/', 'https://warpstack.example.com./', 'https://api.warpstack.example.com/',
      'https://media.warpstack.example.com/img/x', 'https://snap.farcaster.xyz:443/v1/info', 'https://anything.workers.dev/', 'https://a.b.workers.dev./',
    ]) expect(checkUrl(u, policy).ok, u).toBe(false)
  })

  it('allows ordinary public https URLs, including IDNs and the default port', () => {
    for (const u of ['https://example.org/a.png', 'https://i.imgur.com/x.jpg?w=1#frag', 'https://example.org:443/', 'https://bücher.de/', 'https://notwarpstack.example.com/']) {
      expect(checkUrl(u, policy).ok, u).toBe(true)
    }
    const r = checkUrl('https://example.org/x#secret', policy)
    expect(r.ok && r.value.href).toBe('https://example.org/x')
  })
})

/** A hostile web server: each URL gets a response, and every request is recorded. */
const server = (routes: Record<string, (init: RequestInit) => Response | Promise<Response>>) => {
  const seen: { url: string; headers: Headers }[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    seen.push({ url, headers: new Headers(init?.headers) })
    const route = routes[url]
    if (!route) return new Response('not found', { status: 404 })
    return route(init ?? {})
  }) as typeof fetch
  return { fetcher, seen }
}

const limits: FetchLimits = { maxBytes: 1_024, timeoutMs: 200, maxRedirects: 3 }
const go = (url: string, fetcher: typeof fetch, l = limits) => untrustedFetch(url, { policy, limits: l, accept: 'image/*', fetcher })
const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } })
const stream = (chunks: number, size: number) => new ReadableStream<Uint8Array>({
  start(c) {
    for (let i = 0; i < chunks; i++) c.enqueue(new Uint8Array(size))
    c.close()
  },
})

describe('the restricted transport', () => {
  it('fetches a public URL, sending nothing of ours', async () => {
    const s = server({ 'https://example.org/a': () => new Response('hello', { headers: { 'content-type': 'Text/Plain' } }) })
    const r = await go('https://example.org/a', s.fetcher)
    expect(r.ok && new TextDecoder().decode(r.value.bytes)).toBe('hello')
    expect(r.ok && r.value.contentType).toBe('text/plain')
    expect([...s.seen[0]!.headers.keys()].sort()).toEqual(['accept', 'user-agent'])
  })

  it('checks every redirect like the first, and stops after three', async () => {
    const toPrivate = server({ 'https://example.org/a': redirect('https://127.0.0.1/admin') })
    expect(await go('https://example.org/a', toPrivate.fetcher)).toMatchObject({ ok: false, error: { kind: 'refused' } })
    expect(toPrivate.seen).toHaveLength(1)

    const toOurs = server({ 'https://example.org/a': redirect('https://media.warpstack.example.com/x', 307) })
    expect(await go('https://example.org/a', toOurs.fetcher)).toMatchObject({ ok: false, error: { kind: 'refused' } })

    const toHttp = server({ 'https://example.org/a': redirect('http://example.org/b', 301) })
    expect(await go('https://example.org/a', toHttp.fetcher)).toMatchObject({ ok: false, error: { kind: 'refused' } })

    const chain = server({
      'https://example.org/1': redirect('/2'), 'https://example.org/2': redirect('https://example.net/3'),
      'https://example.net/3': redirect('https://example.org/4'), 'https://example.org/4': redirect('https://example.org/5'),
      'https://example.org/5': () => new Response('end'),
    })
    expect(await go('https://example.org/1', chain.fetcher)).toEqual({ ok: false, error: { kind: 'redirects' } })
    expect(chain.seen.map(x => x.url)).toEqual(['https://example.org/1', 'https://example.org/2', 'https://example.net/3', 'https://example.org/4'])

    const loop = server({ 'https://example.org/a': redirect('https://example.org/a') })
    expect(await go('https://example.org/a', loop.fetcher)).toEqual({ ok: false, error: { kind: 'redirects' } })
  })

  it('refuses oversized bodies by declared length and as they stream, compressed or not', async () => {
    const declared = server({ 'https://example.org/a': () => new Response('x', { headers: { 'content-length': '999999' } }) })
    expect(await go('https://example.org/a', declared.fetcher)).toEqual({ ok: false, error: { kind: 'too_large' } })
    // The length lies: a small declaration, then far more bytes.
    const lying = server({ 'https://example.org/a': () => new Response(stream(10, 512), { headers: { 'content-length': '10' } }) })
    expect(await go('https://example.org/a', lying.fetcher)).toEqual({ ok: false, error: { kind: 'too_large' } })
    // A gzip bomb: a few hundred compressed bytes that inflate past the cap. The runtime
    // decodes before the transport counts, as Workers' fetch does.
    const bomb = new Response(stream(64, 1_024)).body!.pipeThrough(new CompressionStream('gzip'))
    const compressed = new Uint8Array(await new Response(bomb).arrayBuffer())
    expect(compressed.length).toBeLessThan(limits.maxBytes)
    const inflating = server({ 'https://example.org/a': () => new Response(new Response(compressed).body!.pipeThrough(new DecompressionStream('gzip'))) })
    expect(await go('https://example.org/a', inflating.fetcher)).toEqual({ ok: false, error: { kind: 'too_large' } })
    // Exactly at the cap is fine.
    const exact = server({ 'https://example.org/a': () => new Response(stream(1, limits.maxBytes)) })
    expect((await go('https://example.org/a', exact.fetcher)).ok).toBe(true)
  })

  it('gives up on a slow server, including one that stalls mid-body', async () => {
    const hang = (init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    const silent = server({ 'https://example.org/a': hang })
    expect(await go('https://example.org/a', silent.fetcher)).toEqual({ ok: false, error: { kind: 'timeout' } })
    const drip = server({
      'https://example.org/a': init => new Response(new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(1))
          init.signal?.addEventListener('abort', () => c.error(new Error('aborted')))
        },
      })),
    })
    expect(await go('https://example.org/a', drip.fetcher)).toEqual({ ok: false, error: { kind: 'timeout' } })
  })

  it('runs a bounded number of fetches at once, refusing the rest rather than queueing them', async () => {
    let release = () => {}
    const held = new Promise<void>(r => { release = r })
    const slow = server({ 'https://example.org/a': async () => { await held; return new Response('ok') } })
    const l = { ...limits, timeoutMs: 5_000 }
    const first = Array.from({ length: MAX_CONCURRENT_FETCHES }, () => go('https://example.org/a', slow.fetcher, l))
    expect(await go('https://example.org/a', slow.fetcher, l)).toEqual({ ok: false, error: { kind: 'busy' } })
    release()
    expect((await Promise.all(first)).every(r => r.ok)).toBe(true)
    // The slots are free again once those finish.
    expect((await go('https://example.org/a', slow.fetcher, l)).ok).toBe(true)
    expect(MAX_CONCURRENT_FETCHES * IMAGE_LIMITS.maxBytes).toBeLessThanOrEqual(32 * 1_024 * 1_024)
  })

  it('reports error statuses without reading them', async () => {
    const s = server({ 'https://example.org/a': () => new Response('nope', { status: 500 }) })
    expect(await go('https://example.org/a', s.fetcher)).toEqual({ ok: false, error: { kind: 'status', status: 500 } })
  })
})

// Minimal real headers for each accepted type.
const bytes = (...parts: (number[] | string | Uint8Array)[]) => Uint8Array.from(parts.flatMap(p =>
  typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : [...p]))
const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, n >>> 8]
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, n >>> 16]
const le32 = (n: number) => [...le24(n), n >>> 24]
const chunk = (type: string, data: number[]) => bytes(be32(data.length), type, data, [0, 0, 0, 0])

const pngOf = (w: number, h: number, ...extra: Uint8Array[]) =>
  bytes('\x89PNG\r\n\x1a\n', chunk('IHDR', [...be32(w), ...be32(h), 8, 6, 0, 0, 0]), ...extra, chunk('IEND', []))
const gifOf = (w: number, h: number, frames: number) => bytes('GIF89a', le16(w), le16(h), [0, 0, 0],
  ...Array.from({ length: frames }, () => [0x2c, 0, 0, 0, 0, ...le16(w), ...le16(h), 0, 2, 2, 0x4c, 0x01, 0]), [0x3b])
const webpOf = (w: number, h: number, exif = false) => {
  const vp8x = bytes('VP8X', le32(10), [exif ? 0x08 : 0, 0, 0, 0], le24(w - 1), le24(h - 1))
  const meta = exif ? bytes('EXIF', le32(2), [0, 0]) : new Uint8Array()
  const body = bytes('WEBP', vp8x, meta)
  return bytes('RIFF', le32(body.length), body)
}
const jpegOf = (w: number, h: number, app1?: string) => bytes([0xff, 0xd8],
  [0xff, 0xe0, 0, 16], 'JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0],
  ...(app1 ? [[0xff, 0xe1, ...[(app1.length + 2) >> 8, (app1.length + 2) & 255]], app1] : []),
  [0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], [0xff, 0xd9])

describe('image checks', () => {
  it('reads the four accepted types from their own bytes', () => {
    expect(checkImage(pngOf(640, 480))).toEqual({ ok: true, value: { type: 'png', width: 640, height: 480, frames: 1, metadata: false } })
    expect(checkImage(gifOf(32, 16, 3))).toEqual({ ok: true, value: { type: 'gif', width: 32, height: 16, frames: 3, metadata: false } })
    expect(checkImage(webpOf(1080, 720))).toEqual({ ok: true, value: { type: 'webp', width: 1080, height: 720, frames: 1, metadata: false } })
    expect(checkImage(jpegOf(1080, 1350))).toEqual({ ok: true, value: { type: 'jpeg', width: 1080, height: 1350, frames: 1, metadata: false } })
  })

  it('refuses SVG, markup and anything else, whatever it calls itself', () => {
    for (const b of [
      bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      bytes('<?xml version="1.0"?><svg/>'), bytes('<!doctype html><html><script>alert(1)</script>'),
      bytes('\xef\xbb\xbf<svg/>'), bytes('%PDF-1.7'), bytes('BM'), bytes([0, 0, 1, 0]), new Uint8Array(), bytes('GIF89a'),
      bytes([0xff, 0xd8, 0xff]), bytes('RIFF\0\0\0\0WEBP'),
    ]) expect(checkImage(b).ok).toBe(false)
  })

  it('refuses pixel bombs and frame bombs from the header alone', () => {
    expect(checkImage(pngOf(100_000, 100_000))).toEqual({ ok: false, error: 'too many pixels' })
    expect(checkImage(jpegOf(65_535, 65_535))).toEqual({ ok: false, error: 'too many pixels' })
    expect(checkImage(webpOf(16_000, 16_000))).toEqual({ ok: false, error: 'too many pixels' })
    expect(checkImage(gifOf(10, 10, IMAGE_POLICY.maxFrames + 1))).toEqual({ ok: false, error: 'too many frames' })
    expect(checkImage(pngOf(10, 10, chunk('acTL', [...be32(10_000), ...be32(0)])))).toEqual({ ok: false, error: 'too many frames' })
  })

  it('reports metadata an upload should have had stripped', () => {
    expect(checkImage(jpegOf(100, 100, 'Exif\0\0MM')).ok && checkImage(jpegOf(100, 100, 'Exif\0\0MM'))).toMatchObject({ value: { metadata: true } })
    expect(checkImage(jpegOf(100, 100, 'http://ns.adobe.com/xap/1.0/\0<x/>'))).toMatchObject({ value: { metadata: true } })
    expect(checkImage(pngOf(10, 10, chunk('tEXt', [...bytes('Comment\0hi')])))).toMatchObject({ value: { metadata: true } })
    expect(checkImage(pngOf(10, 10, chunk('eXIf', [0, 0])))).toMatchObject({ value: { metadata: true } })
    expect(checkImage(webpOf(10, 10, true))).toMatchObject({ value: { metadata: true } })
  })

  it('survives truncated and malformed headers without throwing', () => {
    const good = [pngOf(10, 10), gifOf(10, 10, 2), webpOf(10, 10), jpegOf(10, 10)]
    for (const g of good) for (let n = 0; n < g.length; n++) expect(() => checkImage(g.slice(0, n))).not.toThrow()
    const corrupt = jpegOf(10, 10)
    corrupt[5] = 0
    expect(() => checkImage(corrupt)).not.toThrow()
  })
})

describe('link previews', () => {
  it('reads Open Graph fields as plain, capped text', () => {
    const p = readPreview(`<html><head>
      <title>Fallback</title>
      <meta property="og:title" content="A &amp; B &#x27;quoted&#x27; <b>bold</b>">
      <meta name='description' content='plain description'>
      <meta property="og:site_name" content="Site‮evil">
      <meta property="og:image" content="https://example.org/a.png?x=1&amp;y=2">
      </head><body><meta property="og:title" content="from the body"></body></html>`)
    expect(p).toEqual({ title: 'A & B \'quoted\' bold', description: 'plain description', site: 'Site evil', image: 'https://example.org/a.png?x=1&y=2' })
  })

  it('falls back to <title>, and caps long text', () => {
    const p = readPreview(`<head><title>${'t'.repeat(500)}</title></head>`)
    expect([...p.title!].length).toBe(200)
    expect(p.title!.endsWith('…')).toBe(true)
  })

  it('keeps no markup or script, and stays fast on hostile pages', () => {
    const p = readPreview('<head><meta property="og:title" content="<script>alert(1)</script>hi"><meta property="og:description" content="&#0;&#xD800;ok"></head>')
    expect(p.title).toBe('alert(1) hi')
    expect(p.description).toBe('ok')
    const hostile = `<head>${'<meta '.repeat(50_000)}${'<'.repeat(200_000)}<title>${'a'.repeat(100_000)}`
    const t0 = performance.now()
    readPreview(hostile)
    expect(performance.now() - t0).toBeLessThan(500)
  })
})
