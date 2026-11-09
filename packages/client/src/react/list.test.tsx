// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { createClient } from '../client.ts'
import { useFeedScreen, useHomeFeed, useLookupFid, WarpProvider } from './index.tsx'

const cast = (n: number) => ({
  hash: `0x${n.toString(16).padStart(40, '0')}`, fid: 1, ts: 1_000 - n, type: 'cast', text: `c${n}`, embeds: [], mentions: [],
  counts: { likes: 0, recasts: 0, replies: 0, exact: true }, author: { fid: 1, pro: false },
})

/** A fake deployment: pages of the channel feed, with hooks for failures. */
const server = (opts: { pages: number; fail?: (cursor: string | null, calls: number) => Response | null }) => {
  const calls: (string | null)[] = []
  let head = 0
  let jumped = false
  const fetch = async (input: RequestInfo | URL) => {
    const u = new URL(String(input))
    const cursor = u.searchParams.get('cursor')
    calls.push(cursor)
    const failed = opts.fail?.(cursor, calls.length)
    if (failed) return failed
    const n = cursor ? Number(cursor.slice(1)) : 0
    const items = (cursor ? [n] : jumped ? [300, 301] : [head, n]).map(cast)
    const next = n + 1 < opts.pages ? { kind: 'more', cursor: `p${n + 1}` } : { kind: 'horizon' }
    return new Response(JSON.stringify({ items, next, rev: 1 }), { headers: { 'content-type': 'application/json' } })
  }
  return { calls, fetch: fetch as typeof globalThis.fetch, newer: () => { head = 100 }, jump: () => { jumped = true } }
}

const wrapper = (fetch: typeof globalThis.fetch, client = createClient({ baseUrl: 'https://reader.test', fetch })) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}><WarpProvider client={client}>{children}</WarpProvider></QueryClientProvider>
  )
}

describe('lists', () => {
  it('pages to the horizon', async () => {
    const s = server({ pages: 3 })
    const { result } = renderHook(() => useFeedScreen({ kind: 'channel', key: 'base' }), { wrapper: wrapper(s.fetch) })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.horizon).toBe(true))
    expect(result.current.hasMore).toBe(false)
  })

  it('refreshes by fetching only the first page and merging it in front', async () => {
    const s = server({ pages: 3 })
    const { result } = renderHook(() => useFeedScreen({ kind: 'channel', key: 'base' }), { wrapper: wrapper(s.fetch) })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    const before = s.calls.length
    s.newer()
    await act(() => result.current.refresh())
    await waitFor(() => expect(result.current.items[0]?.text).toBe('c100'))
    expect(s.calls.length - before).toBe(1)
    expect(result.current.items.map(c => c.text)).toEqual(['c100', 'c0', 'c1'])
  })

  it('starts over from the new first page when more than a page is new, rather than leave a gap', async () => {
    const s = server({ pages: 3 })
    const { result } = renderHook(() => useFeedScreen({ kind: 'channel', key: 'base' }), { wrapper: wrapper(s.fetch) })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    s.jump()
    await act(() => result.current.refresh())
    await waitFor(() => expect(result.current.items.map(c => c.text)).toEqual(['c300', 'c301']))
    // Refreshing again doesn't stack first pages.
    await act(() => result.current.refresh())
    await waitFor(() => expect(result.current.items.map(c => c.text)).toEqual(['c300', 'c301']))
  })

  it('reports a failed refresh and keeps the list', async () => {
    let down = false
    const s = server({ pages: 2, fail: () => (down ? new Response('{}', { status: 503 }) : null) })
    const { result } = renderHook(() => useFeedScreen({ kind: 'channel', key: 'base' }), { wrapper: wrapper(s.fetch) })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    down = true
    let failed: unknown = null
    await act(async () => { await result.current.refresh().catch((e: unknown) => { failed = e }) })
    expect(failed).not.toBeNull()
    expect(result.current.items.map(c => c.text)).toEqual(['c0'])
  })

  it('shows a failed next page instead of retrying it in a loop', async () => {
    const s = server({ pages: 3, fail: c => (c ? new Response(JSON.stringify({ defined: true, code: 'RATE_LIMITED', message: 'Rate limited', data: { retryAfter: 60 } }), { status: 429, headers: { 'content-type': 'application/json' } }) : null) })
    const { result } = renderHook(() => useFeedScreen({ kind: 'channel', key: 'base' }), { wrapper: wrapper(s.fetch) })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.loadMore())
    await waitFor(() => expect(result.current.moreError).toMatchObject({ kind: 'rateLimited', retryAfter: 60 }))
    const after = s.calls.length
    await new Promise(r => setTimeout(r, 50))
    expect(s.calls.length).toBe(after)
    expect(result.current.status).toBe('ready')
  })

  it('starts the list over when a cursor is refused', async () => {
    const s = server({ pages: 3, fail: (c, n) => (c === 'p1' && n === 2 ? new Response(JSON.stringify({ defined: true, code: 'CURSOR_INVALID', message: 'Cursor invalid' }), { status: 400, headers: { 'content-type': 'application/json' } }) : null) })
    const { result } = renderHook(() => useFeedScreen({ kind: 'channel', key: 'base' }), { wrapper: wrapper(s.fetch) })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    act(() => result.current.loadMore())
    await waitFor(() => expect(s.calls.filter(c => c === null).length).toBe(2))
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })
})

describe('store selectors', () => {
  it('re-renders a list when one of its casts changes, not when another cast merges', async () => {
    const s = server({ pages: 1 })
    const client = createClient({ baseUrl: 'https://reader.test', fetch: s.fetch })
    let renders = 0
    const { result } = renderHook(() => { renders++; return useFeedScreen({ kind: 'channel', key: 'base' }) }, { wrapper: wrapper(s.fetch, client) })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    const before = renders
    const items = result.current.items
    act(() => client.store.mergeCasts([cast(500) as never], 99))
    expect(renders).toBe(before)
    expect(result.current.items).toBe(items)
    act(() => client.store.mergeCasts([{ ...cast(0), counts: { likes: 7, recasts: 0, replies: 0, exact: true } } as never], 99))
    expect(renders).toBe(before + 1)
    expect(result.current.items[0]?.counts.likes).toBe(7)
  })
})

describe('hook shapes', () => {
  it('reads the account\'s own lists only when signed in, and says so', async () => {
    const s = server({ pages: 1 })
    const { result } = renderHook(() => useHomeFeed(), { wrapper: wrapper(s.fetch) })
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(s.calls).toEqual([])
  })

  it('refuses a second run of an action while the first is busy, and reports errors as data', async () => {
    let release = () => {}
    const fetch = (async () => {
      await new Promise<void>(r => { release = r })
      return new Response(JSON.stringify({ defined: true, code: 'NOT_FOUND', message: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } })
    }) as typeof globalThis.fetch
    const { result } = renderHook(() => useLookupFid(), { wrapper: wrapper(fetch) })
    let first: Promise<unknown> = Promise.resolve()
    act(() => { first = result.current.run('alice') })
    await waitFor(() => expect(result.current.busy).toBe(true))
    expect(await result.current.run('bob')).toMatchObject({ ok: false, error: { kind: 'invalid' } })
    release()
    await act(async () => { expect(await first).toMatchObject({ ok: false, error: { kind: 'notFound' } }) })
    expect(result.current).toMatchObject({ busy: false, error: { kind: 'notFound' } })
    expect(await result.current.run('12')).toEqual({ ok: true, value: 12 })
  })
})
