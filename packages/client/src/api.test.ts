import { describe, expect, it } from 'vitest'
import { canonicalUrl, ContractError, createApi } from './api.ts'
import { retryDelay, shouldRetry } from './react/index.tsx'

const respond = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('the API client', () => {
  it('parses every response, and throws ContractError on a mismatch', async () => {
    const api = createApi({ baseUrl: 'https://reader.test', fetch: respond({ contract: 'nope' }) })
    await expect(api.meta.capabilities({})).rejects.toBeInstanceOf(ContractError)
  })

  it('passes typed errors through untouched', async () => {
    const api = createApi({ baseUrl: 'https://reader.test', fetch: respond({ defined: true, code: 'NOT_FOUND', message: 'Not found' }, 404) })
    await expect(api.user.get({ fid: 1 as never })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('sends canonical URLs, so the cache key doesn\'t depend on argument order', async () => {
    let url = ''
    const api = createApi({ baseUrl: 'https://reader.test/', fetch: async u => { url = String(u); return respond({ items: [], next: { kind: 'end' }, rev: 1 })() } })
    await api.feed.user({ fid: 3 as never, replies: true, cursor: 'abc' as never })
    expect(url).toBe('https://reader.test/api/users/3/feed?cursor=abc&replies=true')
    expect(canonicalUrl('https://x.test/a?b=2&a=1&a=0')).toBe('https://x.test/a?a=0&a=1&b=2')
  })

  it('doesn\'t treat object keys as routes', () => {
    const api = createApi({ baseUrl: 'https://reader.test' }) as unknown as Record<string, unknown>
    expect(typeof api.constructor).toBe('function')
    expect(api.toString).toBeDefined()
  })
})

describe('the retry policy', () => {
  it('retries network errors and 5xx, never 4xx, rate limits or contract mismatches', () => {
    expect(shouldRetry(0, new TypeError('fetch failed'))).toBe(true)
    expect(shouldRetry(0, { status: 503, code: 'UPSTREAM_UNAVAILABLE' })).toBe(true)
    expect(shouldRetry(2, { status: 503 })).toBe(false)
    expect(shouldRetry(0, { status: 404, code: 'NOT_FOUND' })).toBe(false)
    expect(shouldRetry(0, { code: 'RATE_LIMITED', status: 429 })).toBe(false)
    expect(shouldRetry(0, new ContractError('x', []))).toBe(false)
  })

  it('waits as long as RATE_LIMITED says', () => {
    expect(retryDelay(0, { code: 'RATE_LIMITED', data: { retryAfter: 60 } })).toBe(60_000)
    expect(retryDelay(3, new Error('x'))).toBe(8_000)
  })
})
