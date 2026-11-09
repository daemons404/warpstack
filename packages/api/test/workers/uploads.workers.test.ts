import { ed25519 } from '@noble/curves/ed25519.js'
import { toHex } from '@warpstack/protocol'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { HmacMac } from '../../src/adapters/hmac.ts'
import { createApp } from '../../src/app.ts'
import { makeToken } from '../../src/core/session.ts'
import type { Env } from '../../src/env.ts'
import type { UserApi } from '../../src/user-object.ts'

// media.upload in workerd, with a real session and D1: the body is the image itself, with the
// headers the oRPC client sends for a file (POST /api/media, content-disposition). R2 and the Images binding are
// fakes; the Images fake plays the encoder and always returns a WebP.

const e = env as unknown as Env
const NOW = Math.floor(Date.now() / 1000)
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
const MEDIA = 'https://media.reader.test'

const bytes = (...parts: (number[] | string)[]) => Uint8Array.from(parts.flatMap(p => (typeof p === 'string' ? [...p].map(c => c.charCodeAt(0)) : p)))
const be32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, n >>> 16]
const le32 = (n: number) => [...le24(n), n >>> 24]
const pngOf = (w: number, h: number) => bytes('\x89PNG\r\n\x1a\n', be32(13), 'IHDR', be32(w), be32(h), [8, 6, 0, 0, 0], [0, 0, 0, 0], be32(0), 'IEND', [0, 0, 0, 0])
const webpOf = (w: number, h: number) => {
  const body = bytes('WEBP', 'VP8X', le32(10), [0, 0, 0, 0], le24(w - 1), le24(h - 1))
  return bytes('RIFF', le32(body.length), [...body])
}
const jpegWithExif = bytes([0xff, 0xd8], [0xff, 0xe1, 0, 16], 'Exif\0\0MM\0*\0\0\0\0', [0xff, 0xc0, 0, 17, 8, 0, 100, 0, 100, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], [0xff, 0xd9])

const stored = new Map<string, Uint8Array>()
const fakes = {
  MEDIA: { put: async (k: string, v: Uint8Array) => { stored.set(k, v); return null } } as unknown as R2Bucket,
  IMAGES: {
    input: () => {
      const t = { transform: () => t, output: async () => ({ image: () => new Response(webpOf(1080, 540)).body!, contentType: () => 'image/webp' }) }
      return t
    },
  } as unknown as ImagesBinding,
  MEDIA_ORIGIN: MEDIA,
}

let n = 0
const session = async (fid: number) => {
  const token = await makeToken(new HmacMac(e.SESSION_MAC_KEY), fid, new Uint8Array(32).fill(100 + ++n))
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(b => b.toString(16).padStart(2, '0')).join('')
  const user = e.USER.get(e.USER.idFromName(String(fid))) as unknown as UserApi
  const r = await user.openSession(fid, {
    nonce: `upload-${n}`, nonceExpires: NOW + 300, tokenHash: hash, appKey: toHex(ed25519.getPublicKey(new Uint8Array(32).fill(9))),
    device: `upload-device-${n}`, custody: `0x${'c'.repeat(40)}`, now: NOW,
  })
  if (!r.ok) throw new Error('openSession refused')
  return token
}

const app = createApp()
const upload = (body: Uint8Array, token: string | null, extra: Partial<Env> = fakes, type = 'image/png') =>
  app.fetch(new Request('https://reader.test/api/media', {
    // As the oRPC client sends a file: the bytes as the body, named by content-disposition.
    method: 'POST', body, headers: {
      'content-type': type, 'content-disposition': 'inline; filename="photo"', 'standard-server': 'file',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  }), { ...e, ...extra } as Env, ctx)

describe('media.upload', () => {
  it('stores a posted image, re-encoded, and returns its public URL on the media origin', async () => {
    const token = await session(4242)
    const res = await upload(pngOf(2000, 1000), token)
    if (res.status !== 200) throw new Error(await res.text())
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string; width: number; height: number }
    expect(body).toMatchObject({ width: 1080, height: 540 })
    expect(body.url).toMatch(new RegExp(`^${MEDIA}/img/u/[0-9a-f]{64}/1080$`))
    const key = body.url.slice(`${MEDIA}/img/`.length)
    expect(new TextDecoder().decode(stored.get(key)!.subarray(8, 12))).toBe('WEBP')
    // Its own embed is answered from the uploads table, without a fetch.
    const row = await e.DB.prepare('SELECT fid, key FROM uploads WHERE key = ?1').bind(key).first()
    expect(row).toEqual({ fid: 4242, key })
  })

  it('accepts a phone JPEG with its EXIF block (only the re-encoded WebP is stored), and refuses non-images', async () => {
    const token = await session(4243)
    expect((await upload(jpegWithExif, token, fakes, 'image/jpeg')).status).toBe(200)
    expect((await upload(bytes('<svg onload=alert(1)>'), token, fakes, 'image/png')).status).toBe(422)
  })

  it('needs a session, and is off without images', async () => {
    expect((await upload(pngOf(10, 10), null)).status).toBe(401)
    const token = await session(4244)
    expect((await upload(pngOf(10, 10), token, {})).status).toBe(501)
  })
})
