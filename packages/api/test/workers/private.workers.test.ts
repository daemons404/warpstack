import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.ts'
import type { Env } from '../../src/env.ts'

// A private deployment (ACCESS unset): every read needs an allowed user's session; only the
// handshake, first sign-in's key steps and capabilities run without one.

const app = createApp()
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext
const privateEnv = { ...(env as unknown as Env), ACCESS: undefined, ALLOWED_FIDS: '7' } as Env
const call = (path: string, init: RequestInit = {}, e: Env = privateEnv) =>
  app.fetch(new Request(`https://reader.test${path}`, init), e, ctx)

describe('a private deployment', () => {
  it('refuses reads without a session, and never lets a shared cache keep the refusal', async () => {
    for (const path of ['/api/channels', '/api/channels/base/feed', '/api/users/7', `/api/casts/7/0x${'c'.repeat(40)}`]) {
      const res = await call(path)
      expect(res.status, path).toBe(401)
      expect(res.headers.get('cache-control'), path).toBe('no-store')
    }
  })

  it('refuses a made-up token the same way', async () => {
    const res = await call('/api/channels', { headers: { authorization: 'Bearer 7.abc.def' } })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'UNAUTHORIZED', data: { reason: 'session' } })
  })

  it('still runs the handshake and capabilities without one', async () => {
    expect((await call('/api/meta')).status).toBe(200)
    const challenge = await call('/api/session/challenge', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fid: 7, key: `0x${'a'.repeat(64)}` }),
    })
    expect(challenge.status).toBe(200)
  })

  it('answers signer.registration only for allowed FIDs, before the node', async () => {
    const res = await call(`/api/signers/registration?fid=42&key=0x${'a'.repeat(64)}`)
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ code: 'UNAUTHORIZED', data: { reason: 'keyNotAccepted' } })
  })

  it('refuses session.verify for an unlisted FID before the signature or the node', async () => {
    const key = `0x${'a'.repeat(64)}`
    const json = { 'content-type': 'application/json' }
    const c = await (await call('/api/session/challenge', { method: 'POST', headers: json, body: JSON.stringify({ fid: 42, key }) })).json() as { challenge: string }
    const res = await call('/api/session/verify', {
      method: 'POST', headers: json,
      body: JSON.stringify({ fid: 42, key, challenge: c.challenge, signature: `0x${'0'.repeat(128)}` }),
    })
    expect(res.status).toBe(401)
    // Not `signature`: the list is checked first, so a stranger never reaches the node.
    expect(await res.json()).toMatchObject({ code: 'UNAUTHORIZED', data: { reason: 'keyNotAccepted' } })
  })

  it('shows its status only to signed-in users', async () => {
    const res = await call('/_ops/status')
    expect(res.status).toBe(401)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses to start without saying who is allowed', async () => {
    const res = await call('/api/meta', {}, { ...privateEnv, ALLOWED_FIDS: undefined } as Env)
    expect(res.status).toBe(500)
  })
})
