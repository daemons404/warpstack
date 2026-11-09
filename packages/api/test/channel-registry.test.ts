import { describe, expect, it } from 'vitest'
import { FarcasterChannelRegistry } from '../src/adapters/channel-registry.ts'

// A FID's followed channels from the Farcaster client API, paged, with bad entries dropped.

const apiChannel = (id: string) => ({ id, url: `https://farcaster.xyz/~/channel/${id}`, name: id, followerCount: 1, followedAt: 1 })

describe('followed channels from the Farcaster client API', () => {
  it('follows the cursor across pages, and drops entries that are not channels', async () => {
    const asked: string[] = []
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input)
      asked.push(url)
      const body = url.includes('cursor=p2')
        ? { result: { channels: [apiChannel('golf')] } }
        : { result: { channels: [apiChannel('base'), { id: 'Not A Key!', url: 'x' }] }, next: { cursor: 'p2' } }
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const r = await new FarcasterChannelRegistry(fetcher).followedBy(1234)
    expect(r.ok && r.value.map(c => c.key)).toEqual(['base', 'golf'])
    expect(asked[0]).toBe('https://api.farcaster.xyz/v1/user-following-channels?fid=1234&limit=100')
    expect(asked[1]).toContain('cursor=p2')
  })

  it('reports the API being down or changing shape, rather than an empty list', async () => {
    const down = new FarcasterChannelRegistry((async () => new Response('no', { status: 503 })) as typeof fetch)
    expect((await down.followedBy(1)).ok).toBe(false)
    const odd = new FarcasterChannelRegistry((async () => new Response('{"nope":1}')) as typeof fetch)
    expect((await odd.followedBy(1)).ok).toBe(false)
  })
})
