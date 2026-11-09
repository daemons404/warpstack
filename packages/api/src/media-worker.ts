// The media origin: a Worker of its own,
// on its own hostname, that serves stored images from R2 and nothing else. It never fetches a
// URL, so it can't be used as a proxy; a key the API hasn't stored is a 404. Everything it
// serves was re-encoded by Cloudflare's Images binding before it was stored, and every
// response forbids sniffing and scripts, so a file can never run as a page.

import { systemClock } from './adapters/clock.ts'
import { HmacMac } from './adapters/hmac.ts'
import { mediaTokenValid } from './core/media-token.ts'

export interface MediaEnv {
  MEDIA: R2Bucket
  /** `public`: anyone may load images. Otherwise (private) an allowed user's media token is needed. */
  ACCESS?: string
  /** Secret shared with the API, which makes the tokens. */
  MEDIA_KEY?: string
}

/**
 * `a/` avatars and `p/` proxied images (a SHA-256 of the source URL and the stored width), and
 * `u/` images members posted (a SHA-256 of the uploaded bytes and the width).
 */
const KEY = /^[apu]\/[0-9a-f]{64}\/[0-9]{1,5}$/

const HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
  'cross-origin-resource-policy': 'cross-origin',
  'referrer-policy': 'no-referrer',
}

// Not cached: an avatar can be named a moment before it's stored, and the app retries.
const notFound = () => new Response('Not found', { status: 404, headers: { ...HEADERS, 'cache-control': 'no-store' } })

export default {
  async fetch(req: Request, env: MediaEnv): Promise<Response> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { ...HEADERS, allow: 'GET, HEAD' } })
    const path = new URL(req.url).pathname
    if (!path.startsWith('/img/')) return notFound()
    const key = path.slice('/img/'.length)
    if (!KEY.test(key)) return notFound()
    // Private: avatars and proxied images open only with an allowed user's token. A private
    // deployment without MEDIA_KEY serves nothing rather than everything.
    // Posted images are public: a cast names them, and every Farcaster app must load them.
    const open = env.ACCESS === 'public' || key.startsWith('u/')
    if (!open) {
      if (!env.MEDIA_KEY || env.MEDIA_KEY.length < 32) return new Response('Media is not configured', { status: 503, headers: { ...HEADERS, 'cache-control': 'no-store' } })
      const t = new URL(req.url).searchParams.get('t')
      if (!(await mediaTokenValid(new HmacMac(env.MEDIA_KEY), t, systemClock.now()))) {
        return new Response('Forbidden', { status: 403, headers: { ...HEADERS, 'cache-control': 'no-store' } })
      }
    }
    const object = await env.MEDIA.get(key)
    // A takedown deletes the object, so a key that was taken down is simply gone.
    if (!object) return notFound()
    return new Response(req.method === 'HEAD' ? null : object.body, {
      headers: {
        ...HEADERS,
        // Only what the API stored, which is only ever WebP.
        'content-type': 'image/webp',
        'content-length': String(object.size),
        // Keys never change content, but a takedown must take effect: a day in caches, not forever.
        // Private images stay out of shared caches.
        'cache-control': open ? 'public, max-age=86400' : 'private, max-age=86400',
        etag: object.httpEtag,
      },
    })
  },
}
