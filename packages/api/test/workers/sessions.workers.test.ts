import { contract, getFacts, type Facts } from '@warpstack/contract'
import { walkProcedureContractsSync } from '@orpc/server'
import { ed25519 } from '@noble/curves/ed25519.js'
import { encodeEnvelope, encodeMessageData, messageHash, toBase64Url, toFarcasterTime, toHex, type Timestamp } from '@warpstack/protocol'
import { env, exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'
import { HmacMac } from '../../src/adapters/hmac.ts'
import { makeToken } from '../../src/core/session.ts'
import type { UserApi } from '../../src/user-object.ts'

// Sessions in workerd, against real Durable Objects and D1. The test node doesn't exist, so a
// session is opened directly on the user object, as `session.verify` does after its checks,
// with a token made from the test deployment's secret.

type E = { DB: D1Database; USER: DurableObjectNamespace; SESSION_MAC_KEY: string }
const e = env as unknown as E
const worker = (exports as unknown as { default: { fetch: (r: Request) => Promise<Response> } }).default
const NOW = Math.floor(Date.now() / 1000)
const BASE = 'https://reader.test'
const seed = new Uint8Array(32).fill(5)
const KEY = toHex(ed25519.getPublicKey(seed))

const user = (fid: number) => e.USER.get(e.USER.idFromName(String(fid))) as unknown as UserApi
const sha256Hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('')

let n = 0
const openSession = async (fid: number) => {
  const token = await makeToken(new HmacMac(e.SESSION_MAC_KEY), fid, new Uint8Array(32).fill(++n))
  const r = await user(fid).openSession(fid, {
    nonce: `nonce-${n}`, nonceExpires: NOW + 300, tokenHash: await sha256Hex(token), appKey: KEY, device: `device-${n}`,
    custody: `0x${'c'.repeat(40)}`, now: NOW,
  })
  if (!r.ok) throw new Error('openSession refused')
  return token
}

const call = (path: string, init: RequestInit & { token?: string } = {}) => {
  const headers = new Headers(init.headers)
  if (init.token) headers.set('authorization', `Bearer ${init.token}`)
  if (init.body) headers.set('content-type', 'application/json')
  return worker.fetch(new Request(`${BASE}${path}`, { ...init, headers }))
}

const signed = (fid: number) => {
  const data = encodeMessageData({ fid, timestamp: toFarcasterTime(NOW as Timestamp), body: { type: 'castAdd', text: 'gm' } })
  if (!data.ok) throw new Error(data.error.detail)
  const hash = messageHash(data.value)
  return toBase64Url(encodeEnvelope({ dataBytes: data.value, hash, signature: ed25519.sign(hash, seed), signer: ed25519.getPublicKey(seed) }))
}

let token = ''
beforeAll(async () => {
  await e.DB.batch([
    e.DB.prepare('INSERT OR REPLACE INTO ingest_cursor VALUES (1, 1, 1, ?1, ?2), (2, 1, 1, ?1, ?2)').bind(NOW - 5, NOW - 3_600),
    e.DB.prepare(`INSERT OR REPLACE INTO casts (hash, fid, ts, reply, parent_hash, parent_fid, channel, type, text, embeds, mentions)
                  VALUES (?1, 77, ?2, 0, NULL, NULL, NULL, 'cast', 'from a followed account', '[]', '[]')`).bind(`0x${'d'.repeat(40)}`, NOW - 30),
    e.DB.prepare(`INSERT OR REPLACE INTO casts (hash, fid, ts, reply, parent_hash, parent_fid, channel, type, text, embeds, mentions)
                  VALUES (?1, 78, ?2, 0, NULL, NULL, NULL, 'cast', 'from a stranger', '[]', '[]')`).bind(`0x${'e'.repeat(40)}`, NOW - 20),
    e.DB.prepare('INSERT OR REPLACE INTO following_cache (fid, fids, complete, ts) VALUES (1234, ?1, 1, ?2)').bind('[77]', NOW),
  ])
  token = await openSession(1234)
})

describe('session routes', () => {
  it('every session route refuses a request without a session, and none is cached', async () => {
    const routes: { path: string; method: string }[] = []
    walkProcedureContractsSync(contract, p => {
      const f = getFacts(p as never) as Facts
      if (f.auth === 'session') routes.push({ path: f.path, method: f.kind === 'write' ? 'POST' : 'GET' })
    })
    expect(routes.length).toBeGreaterThanOrEqual(7)
    for (const r of routes) {
      const q = r.path === '/api/messages/status' ? `?hashes=0x${'1'.repeat(40)}` : ''
      for (const t of [undefined, 'garbage', token.replace(/^1234/, '1726')]) {
        const res = await call(`${r.path}${q}`, { method: r.method, token: t, ...(r.method === 'POST' ? { body: '{}' } : {}) })
        expect(res.status, `${r.method} ${r.path} with ${t ?? 'no token'}`).toBe(401)
        expect(res.headers.get('cache-control')).toBe('no-store')
      }
    }
  })

  it('serves the session\'s own following feed, privately', async () => {
    const res = await call('/api/feed/following', { token })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toMatch(/^private/)
    const body = await res.json() as { items: { text: string }[] }
    expect(body.items.map(c => c.text)).toEqual(['from a followed account'])
  })

  it('reads the user object for viewer state and message status', async () => {
    const r = await call('/api/viewer/reactions', { token })
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ likes: [], recasts: [] })
    const h = `0x${'4'.repeat(40)}`
    const s = await call(`/api/messages/status?hashes=${h}`, { token })
    expect(s.status).toBe(200)
    expect(await s.json()).toEqual({ states: { [h]: 'unknown' } })
  })

  it('takes a cast only with a session for the cast\'s own FID', async () => {
    const mine = await call('/api/messages', { method: 'POST', token, body: JSON.stringify({ message: signed(1234) }) })
    // Past every check; the node doesn't exist here.
    expect(mine.status).toBe(503)
    const other = await call('/api/messages', { method: 'POST', token, body: JSON.stringify({ message: signed(2) }) })
    expect(other.status).toBe(401)
    expect(((await other.json()) as { data: { reason: string } }).data.reason).toBe('fidMismatch')
  })

  it('issues a stateless challenge and refuses a bad signature before the node', async () => {
    const c = await call('/api/session/challenge', { method: 'POST', body: JSON.stringify({ fid: 1234, key: KEY }) })
    expect(c.status).toBe(200)
    const body = await c.json() as { challenge: string; nonce: string; expiresAt: number }
    expect(body.nonce).toMatch(/^0x[0-9a-f]{64}$/)
    expect(Object.keys(body).sort()).toEqual(['challenge', 'expiresAt', 'nonce'])
    const v = await call('/api/session/verify', {
      method: 'POST', body: JSON.stringify({ fid: 1234, key: KEY, challenge: body.challenge, signature: `0x${'0'.repeat(128)}` }),
    })
    expect(v.status).toBe(401)
    expect(((await v.json()) as { data: { reason: string } }).data.reason).toBe('signature')
  })

  it('reports that this deployment has no app FID', async () => {
    const r = await call('/api/signers/request', { method: 'POST', body: JSON.stringify({ key: KEY, domain: 'gasless' }) })
    expect(r.status).toBe(501)
  })

  it('ends one session and leaves the others', async () => {
    const a = await openSession(1234)
    const b = await openSession(1234)
    expect((await call('/api/session/end', { method: 'POST', token: a, body: '{}' })).status).toBe(200)
    expect((await call('/api/viewer/links', { token: a })).status).toBe(401)
    expect((await call('/api/viewer/links', { token: b })).status).toBe(200)
  })
})
