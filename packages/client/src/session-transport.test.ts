import { describe, expect, it } from 'vitest'
import { createApi, PRE_SESSION_PATHS } from './api.ts'

// The session token travels on every request but the pre-session ones, because a members-only
// deployment gates its reads too, and one re-verify follows a 401 that says the session is gone.

const BASE = 'https://warpstack.test'

const recorder = (respond: (url: URL, auth: string | null, n: number) => Response) => {
  const calls: { path: string; auth: string | null }[] = []
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const auth = new Headers(init?.headers).get('authorization')
    calls.push({ path: url.pathname, auth })
    return respond(url, auth, calls.length)
  }) as typeof fetch
  return { calls, f }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const page = { items: [], next: { kind: 'end' }, rev: 1 }

describe('the session transport', () => {
  it('keeps the token off exactly the routes that run before a session exists', () => {
    expect([...PRE_SESSION_PATHS].sort()).toEqual([
      '/api/meta', '/api/session/challenge', '/api/session/verify', '/api/signers/registration', '/api/signers/request',
    ])
  })

  it('sends the token on reads and session routes, never on the handshake', async () => {
    const { calls, f } = recorder(u => (u.pathname === '/api/meta'
      ? json({ contract: '0.2.0', status: 'ok', modules: ['core'], origins: { api: BASE }, appFid: null, chains: [], miniappNotifications: false, walletActivity: false })
      : json(page)))
    const api = createApi({ baseUrl: BASE, fetch: f, auth: { token: () => 'tok', renew: async () => 'tok' } })
    await api.meta.capabilities({})
    await api.feed.following({})
    await api.feed.channel({ key: 'base' as never })
    expect(calls).toEqual([
      { path: '/api/meta', auth: null },
      { path: '/api/feed/following', auth: 'Bearer tok' },
      { path: '/api/channels/base/feed', auth: 'Bearer tok' },
    ])
  })

  it('sends no token when signed out', async () => {
    const { calls, f } = recorder(() => json(page))
    const api = createApi({ baseUrl: BASE, fetch: f, auth: { token: () => null, renew: async () => null } })
    await api.feed.channel({ key: 'base' as never })
    expect(calls).toEqual([{ path: '/api/channels/base/feed', auth: null }])
  })

  it('waits until the account is known before deciding whether to send a token', async () => {
    const { calls, f } = recorder(() => json(page))
    let token: string | null = null
    let loaded: () => void = () => {}
    const ready = new Promise<void>(r => { loaded = r })
    const api = createApi({ baseUrl: BASE, fetch: f, auth: { token: () => token, renew: async () => token, ready: () => ready } })
    const pending = api.feed.channel({ key: 'base' as never })
    await new Promise(r => setTimeout(r, 0))
    expect(calls).toEqual([])
    token = 'tok'
    loaded()
    await pending
    expect(calls).toEqual([{ path: '/api/channels/base/feed', auth: 'Bearer tok' }])
  })

  it('opens a session when there is none, and re-verifies once on a 401 for a gone session', async () => {
    let renewals = 0
    const { calls, f } = recorder((_, auth) => (auth === 'Bearer fresh-2' ? json(page) : json({ defined: true, code: 'UNAUTHORIZED', message: 'Sign in again', data: { reason: 'session' } }, 401)))
    const api = createApi({ baseUrl: BASE, fetch: f, auth: { token: () => null, renew: async () => `fresh-${++renewals}` } })
    await api.feed.following({})
    expect(calls.map(c => c.auth)).toEqual(['Bearer fresh-1', 'Bearer fresh-2'])
  })

  it('gives up after the second 401', async () => {
    const { calls, f } = recorder(() => json({ defined: true, code: 'UNAUTHORIZED', message: 'Sign in again', data: { reason: 'session' } }, 401))
    const api = createApi({ baseUrl: BASE, fetch: f, auth: { token: () => 'old', renew: async () => 'new' } })
    await expect(api.feed.following({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(calls).toHaveLength(2)
  })

  it('uploads a photo as a file body, with the session, as the server decodes it', async () => {
    const seen: { type: string | null; disposition: string | null; marker: string | null; auth: string | null; size: number }[] = []
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init)
      seen.push({ type: req.headers.get('content-type'), disposition: req.headers.get('content-disposition'), marker: req.headers.get('standard-server'), auth: req.headers.get('authorization'), size: (await req.arrayBuffer()).byteLength })
      return json({ url: 'https://media.test/img/u/x/1080', width: 1080, height: 540 })
    }) as typeof fetch
    const api = createApi({ baseUrl: BASE, fetch: f, auth: { token: () => 'tok', renew: async () => 'tok' } })
    await api.media.upload(new File([new Uint8Array(1234)], 'photo.jpg', { type: 'image/jpeg' }))
    expect(seen).toEqual([{ type: 'image/jpeg', disposition: expect.stringContaining('filename="photo.jpg"'), marker: 'file', auth: 'Bearer tok', size: 1234 }])
  })
})
