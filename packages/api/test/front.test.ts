import { BODY_MAX_BYTES, MEDIA_UPLOAD_MAX_BYTES, PRE_SESSION_PATHS, ROUTES, routeOf } from '@warpstack/contract'
import { describe, expect, it } from 'vitest'
import { callerKey } from '../src/core/ip.ts'
import { admit, type Limiters } from '../src/front.ts'

// The front door: what's refused before oRPC reads a request's body.

const limiter = (allow = true) => {
  const keys: string[] = []
  return { keys, limit: async ({ key }: { key: string }) => { keys.push(key); return { success: allow } } }
}
const limiters = (allow = true) => {
  const read = limiter(allow), upstream = limiter(allow)
  return { read, upstream, all: { READ_IP: read, UPSTREAM_IP: upstream, WRITE_FID: limiter() } as unknown as Limiters }
}
const req = (method: string, path: string, init: RequestInit = {}) => new Request(`https://api.test${path}`, { method, ...init })
const json = { 'content-type': 'application/json' }

/** A body that arrives in chunks with no Content-Length, as a chunked upload does. */
const chunked = (bytes: number) => {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= bytes) return c.close()
      const n = Math.min(1_024, bytes - sent)
      sent += n
      c.enqueue(new Uint8Array(n))
    },
  })
}

describe('caller keys', () => {
  it('counts IPv4 by address and IPv6 by its /64', () => {
    expect(callerKey('203.0.113.9')).toBe('203.0.113.9')
    expect(callerKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64')
    expect(callerKey('2001:0DB8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64')
    expect(callerKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(callerKey('::ffff:198.51.100.7')).toBe('198.51.100.7')
    expect(callerKey('fe80::1%en0')).toBe('fe80:0:0:0::/64')
  })
})

describe('the route table', () => {
  it('finds every route by its method and a concrete path', () => {
    for (const r of ROUTES) {
      const path = r.path.replace(/\{[^}]+\}/g, '7')
      expect(routeOf(r.method, path)?.path, r.path).toBe(r.path)
    }
    expect(routeOf('GET', '/api/nope')).toBeUndefined()
    expect(routeOf('POST', '/api/users/7')).toBeUndefined()
  })

  it('names the routes that run before a session, and nothing else', () => {
    expect([...PRE_SESSION_PATHS].every(p => routeOf(p === '/api/meta' ? 'GET' : 'POST', p) || routeOf('GET', p))).toBe(true)
    expect(PRE_SESSION_PATHS.has('/api/meta')).toBe(true)
    expect(PRE_SESSION_PATHS.has('/api/channels')).toBe(false)
  })
})

describe('admission', () => {
  const open = { ip: '203.0.113.9', access: 'public' as const }

  it('refuses an unknown route without counting it', async () => {
    const l = limiters()
    const a = await admit(req('GET', '/api/nope'), { ...open, limiters: l.all })
    expect(a.ok ? 200 : a.response.status).toBe(404)
    expect(l.read.keys).toEqual([])
  })

  it('counts every request per caller, and upstream ones against the upstream limit too', async () => {
    const l = limiters()
    await admit(req('GET', '/api/channels'), { ...open, limiters: l.all })
    await admit(req('GET', '/api/users/7'), { ...open, ip: '2001:db8:1:2::99', limiters: l.all })
    expect(l.read.keys).toEqual(['READ_IP:203.0.113.9', 'READ_IP:2001:db8:1:2::/64'])
    const upstream = [routeOf('GET', '/api/channels'), routeOf('GET', '/api/users/7')].map(r => r!.cost === 'upstream')
    expect(l.upstream.keys).toEqual(['READ_IP:203.0.113.9', 'READ_IP:2001:db8:1:2::/64'].filter((_, i) => upstream[i]).map(k => k.replace('READ_IP', 'UPSTREAM_IP')))
  })

  it('answers RATE_LIMITED with Retry-After', async () => {
    const a = await admit(req('GET', '/api/channels'), { ...open, limiters: limiters(false).all })
    if (a.ok) throw new Error('expected a refusal')
    expect(a.response.status).toBe(429)
    expect(a.response.headers.get('retry-after')).toBe('60')
    expect(await a.response.json()).toMatchObject({ defined: true, code: 'RATE_LIMITED', data: { retryAfter: 60 } })
  })

  it('refuses a session route with no token before reading its body', async () => {
    const body = chunked(10 * 1_024 * 1_024)
    const a = await admit(req('POST', '/api/media', { body, duplex: 'half' } as RequestInit), { ...open, limiters: limiters().all })
    if (a.ok) throw new Error('expected a refusal')
    expect(a.response.status).toBe(401)
    expect(body.locked).toBe(false)
  })

  it('on a private deployment, refuses public reads with no token but runs the handshake', async () => {
    const closed = { ip: '203.0.113.9', access: 'private' as const, limiters: limiters().all }
    const a = await admit(req('GET', '/api/channels'), closed)
    expect(a.ok ? 200 : a.response.status).toBe(401)
    const b = await admit(req('POST', '/api/session/challenge', { headers: json, body: '{}' }), closed)
    expect(b.ok).toBe(true)
    // A KEY_ADD is its own credential.
    const c = await admit(req('POST', '/api/messages', { headers: json, body: '{}' }), closed)
    expect(c.ok).toBe(true)
  })

  it('refuses a body over the route limit, declared or streamed', async () => {
    const big = 'x'.repeat(BODY_MAX_BYTES + 1)
    const declared = await admit(req('POST', '/api/messages', { headers: json, body: big }), { ...open, limiters: limiters().all })
    expect(declared.ok ? 200 : declared.response.status).toBe(400)
    const streamed = await admit(req('POST', '/api/messages', { headers: json, body: chunked(BODY_MAX_BYTES + 1), duplex: 'half' } as RequestInit), { ...open, limiters: limiters().all })
    if (streamed.ok) throw new Error('expected a refusal')
    expect(await streamed.response.json()).toMatchObject({ code: 'BAD_INPUT' })
  })

  it('lets an upload carry its image, and passes the body on intact', async () => {
    const auth = { authorization: 'Bearer 7.a.b' }
    const ok = await admit(req('POST', '/api/media', { headers: auth, body: chunked(MEDIA_UPLOAD_MAX_BYTES), duplex: 'half' } as RequestInit), { ...open, limiters: limiters().all })
    if (!ok.ok) throw new Error(`expected admission, got ${ok.response.status}`)
    expect((await ok.request.arrayBuffer()).byteLength).toBe(MEDIA_UPLOAD_MAX_BYTES)
  })

  it('passes a call\'s body on, and serves a read with none', async () => {
    const a = await admit(req('POST', '/api/session/challenge', { headers: json, body: '{"fid":7}' }), { ...open, limiters: limiters().all })
    if (!a.ok) throw new Error('expected admission')
    expect(await a.request.text()).toBe('{"fid":7}')
    const r = await admit(new Request('https://api.test/api/channels', { method: 'GET' }), { ...open, limiters: limiters().all })
    if (!r.ok) throw new Error('expected admission')
    expect(r.request.body).toBeNull()
  })
})
