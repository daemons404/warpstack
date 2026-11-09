import { contract } from '@warpstack/contract'
import { describe, expect, it } from 'vitest'
import { ContractError, createApi, InputError, staleTimeOf } from './api.ts'
import { toWarpError, warpError } from './errors.ts'

// The query helpers every route carries, and the one
// error type everything reports.

const BASE = 'https://warpstack.test/'
const ORIGIN = 'https://warpstack.test'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const cast = (n: number) => ({
  hash: `0x${n.toString(16).padStart(40, '0')}`, fid: 1, ts: 1_000 - n, type: 'cast', text: `c${n}`, embeds: [], mentions: [],
  counts: { likes: 0, recasts: 0, replies: 0, exact: true }, author: { fid: 1, pro: false },
})

describe('query helpers', () => {
  const urls: string[] = []
  const api = createApi({
    baseUrl: BASE,
    fetch: (async (input: RequestInfo | URL) => {
      const u = new URL(String(input))
      urls.push(`${u.pathname}${u.search}`)
      const cursor = u.searchParams.get('cursor')
      return json({ items: [cast(cursor ? 2 : 1)], next: cursor ? { kind: 'horizon' } : { kind: 'more', cursor: 'p2' }, rev: 1 })
    }) as typeof fetch,
  })

  it('keys every query by origin, route path and input, so a prefix covers a whole section', () => {
    expect(api.feed.queryKey()).toEqual([ORIGIN, 'feed'])
    expect(api.feed.channel.queryKey()).toEqual([ORIGIN, 'feed', 'channel'])
    expect(api.feed.channel.queryKey({ key: 'base' as never })).toEqual([ORIGIN, 'feed', 'channel', { key: 'base' }])
    const o = api.feed.channel.queryOptions({ key: 'base' as never })
    expect(o.queryKey.slice(0, 2)).toEqual(api.feed.queryKey())
    expect(api.feed.channel.infiniteOptions({ key: 'base' as never }).queryKey).toEqual([ORIGIN, 'feed', 'channel', 'pages', { key: 'base' }])
  })

  it('takes staleTime from the route\'s fresh fact', () => {
    expect(api.feed.channel.queryOptions({ key: 'base' as never }).staleTime).toBe(staleTimeOf(contract.feed.channel))
    expect(api.feed.channel.queryOptions({ key: 'base' as never }).staleTime).toBeGreaterThan(0)
  })

  it('fetches through the parsed client, and pages by cursor until there\'s no more', async () => {
    const o = api.feed.channel.infiniteOptions({ key: 'base' as never })
    const first = await o.queryFn({ pageParam: o.initialPageParam })
    expect(o.getNextPageParam(first)).toBe('p2')
    const second = await o.queryFn({ pageParam: 'p2' })
    expect(o.getNextPageParam(second)).toBeUndefined()
    expect(urls.slice(-2)).toEqual(['/api/channels/base/feed', '/api/channels/base/feed?cursor=p2'])
    expect((await api.feed.channel.queryOptions({ key: 'base' as never }).queryFn()).items).toHaveLength(1)
  })
})

describe('WarpError', () => {
  it('turns server codes into kinds, with retry advice', () => {
    expect(toWarpError({ code: 'NOT_FOUND' })).toMatchObject({ kind: 'notFound', retryable: false })
    expect(toWarpError({ code: 'RATE_LIMITED', data: { retryAfter: 30 } })).toMatchObject({ kind: 'rateLimited', retryable: true, retryAfter: 30 })
    expect(toWarpError({ code: 'UPSTREAM_UNAVAILABLE' })).toMatchObject({ kind: 'network', retryable: true })
    expect(toWarpError({ code: 'UNAUTHORIZED', data: { reason: 'keyInactive' } })).toMatchObject({ kind: 'unauthorized', message: expect.stringContaining('no longer active') })
    expect(toWarpError({ code: 'REJECTED', data: { reason: 'duplicate' } })).toMatchObject({ kind: 'rejected', message: expect.stringContaining('duplicate') })
    expect(toWarpError({ code: 'MODULE_DISABLED', data: { module: 'wallet' } })).toMatchObject({ kind: 'unavailable', retryable: false })
  })

  it('says "update" for a contract mismatch, and "network" for a failed fetch', () => {
    expect(toWarpError(new ContractError('feed.channel', []))).toMatchObject({ kind: 'update', retryable: false })
    expect(toWarpError(new InputError('feed.channel'))).toMatchObject({ kind: 'invalid', retryable: false })
    expect(toWarpError(new TypeError('Network request failed'))).toMatchObject({ kind: 'network', retryable: true })
  })

  it('passes a WarpError through unchanged', () => {
    const e = warpError('phrase', 'stopped')
    expect(toWarpError(e)).toBe(e)
  })

  it('refuses input that fails the contract before sending it', async () => {
    let sent = 0
    const api = createApi({ baseUrl: BASE, fetch: (async () => { sent++; return json({}) }) as typeof fetch })
    await expect(api.feed.channel({ key: 'NOT A KEY!' as never })).rejects.toBeInstanceOf(InputError)
    expect(sent).toBe(0)
  })
})
