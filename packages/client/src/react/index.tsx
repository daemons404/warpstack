import type { AppKey, Cast, CastOrTombstone, Channel, EmbedMetadata, Notification, Page, User } from '@warpstack/contract'
import { err, looksLikePhrase, ok, parseFname, type Result, type UserDataField } from '@warpstack/protocol'
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient, type UseQueryResult } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { AccountState } from '../account.ts'
import type { QueryKey } from '../api.ts'
import type { WarpClient } from '../client.ts'
import { draftProblem, prepareCast, type Draft } from '../compose.ts'
import { codeOf, toWarpError, warpError, type WarpError } from '../errors.ts'

// Screen hooks, in a thin React entry point that works the same in
// React Native and on the web. Screens never call the API directly. Every hook returns one of
// three shapes, and every error is a `WarpError`:
//
// - `Read<T>`: one value, with `status`, `error` and `retry`.
// - `ListState<T>`: pages of items, with load-more, refresh and the same `status` and `error`.
// - `Action<I, O>`: `run(input)` resolving to a `Result`, with `busy` and the last `error`.
//   The like, recast and follow toggles are actions with an `on` state.
//
// Hooks for the signed-in account take no FID: the session decides it, and their query keys
// carry it, so one account's data never shows under another.

const ClientContext = createContext<WarpClient | null>(null)

export const WarpProvider = ({ client, children }: { client: WarpClient; children: ReactNode }) =>
  <ClientContext.Provider value={client}>{children}</ClientContext.Provider>

export const useWarp = (): WarpClient => {
  const c = useContext(ClientContext)
  if (!c) throw new Error('useWarp needs a <WarpProvider> above it')
  return c
}

/** Retry policy: only network failures retry here, twice; rate limits wait for the person. */
export const shouldRetry = (failures: number, e: unknown): boolean => failures < 2 && toWarpError(e).kind === 'network'

/** Honours `RATE_LIMITED.retryAfter`; otherwise exponential, capped at a minute. */
export const retryDelay = (failures: number, e: unknown): number => {
  const after = toWarpError(e).retryAfter
  return after ? after * 1_000 : Math.min(1_000 * 2 ** failures, 60_000)
}

/** Every query's retry policy, so it holds whatever defaults the app's QueryClient has. */
const policy = { retry: shouldRetry, retryDelay }

/** One value: `idle` while it isn't asked for (signed out, say), then `loading`, `error` or `ready`. */
export type Read<T> = {
  data: T | undefined
  status: 'idle' | 'loading' | 'error' | 'ready'
  error: WarpError | null
  retry: () => void
}

const toRead = <T,>(q: UseQueryResult<T, unknown>, enabled = true): Read<T> => ({
  data: q.data,
  status: q.isSuccess ? 'ready' : q.isError ? 'error' : enabled ? 'loading' : 'idle',
  error: q.error ? toWarpError(q.error) : null,
  retry: () => void q.refetch(),
})

/** Something the person does. `run` resolves to a `Result`; a second `run` while one is busy is refused. */
export type Action<I, O> = {
  run: (input: I) => Promise<Result<O, WarpError>>
  busy: boolean
  /** The last run's error, cleared when the next one starts. */
  error: WarpError | null
}

/** A like, recast or follow: an action with the state it toggles. */
export type Toggle = Omit<Action<void, void>, 'run'> & { on: boolean; toggle: () => Promise<Result<void, WarpError>> }

const BUSY = warpError('invalid', 'Already working on it.')

/** Wraps `fn` as an `Action`. The in-flight flag is set before the first await, so a double tap can't run twice. */
const useAction = <I, O>(fn: (input: I) => Promise<Result<O, WarpError>>): Action<I, O> => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<WarpError | null>(null)
  const inFlight = useRef(false)
  const latest = useRef(fn)
  latest.current = fn
  const run = useCallback(async (input: I): Promise<Result<O, WarpError>> => {
    if (inFlight.current) return err(BUSY)
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      const r = await latest.current(input).catch((e: unknown) => err(toWarpError(e)))
      setError(r.ok ? null : r.error)
      return r
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }, [])
  return { run, busy, error }
}

/** Two arrays with the same items, by identity. */
const sameItems = <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]))

/**
 * A value read from the entity store, re-rendering only when it changes (by `equal`). The
 * store's reads are stable, so a list re-renders when one of its own casts changes, not when
 * any merge happens.
 */
export const useStoreSelector = <T,>(select: (store: WarpClient['store']) => T, equal: (a: T, b: T) => boolean = Object.is): T => {
  const { store } = useWarp()
  const latest = useRef(select)
  latest.current = select
  const held = useRef<{ value: T } | null>(null)
  const subscribe = useCallback((l: () => void) => store.subscribe(l), [store])
  const read = () => {
    const next = latest.current(store)
    if (held.current && equal(held.current.value, next)) return held.current.value
    held.current = { value: next }
    return next
  }
  return useSyncExternalStore(subscribe, read, read)
}

/** A key for the signed-in account's own data: the route's key and the FID. */
const mine = (key: QueryKey, fid: number | null): QueryKey => [...key, { viewer: fid }]

export type ListState<T> = {
  items: T[]
  status: 'idle' | 'loading' | 'error' | 'empty' | 'ready'
  error: WarpError | null
  /** Another page exists. */
  hasMore: boolean
  /** The list reached the index's window: older items exist but aren't served here. */
  horizon: boolean
  loadingMore: boolean
  /** The last attempt to load another page failed; automatic loading stops until `loadMore` is called again. */
  moreError: WarpError | null
  loadMore: () => void
  /** Reloads the first page; resolves when it's in, rejects if it failed (the list stays as it was). */
  refresh: () => Promise<void>
  /** Set while the index doesn't cover this list before the given time. */
  incompleteBefore?: number | undefined
}

/**
 * One list over the infinite-query cache. Refresh fetches only the first page and merges
 * it into the loaded first page, instead of
 * re-requesting every loaded page; when nothing in it was loaded before, more than a page is
 * new and the list starts over from it rather than leave a gap. A `CURSOR_INVALID` drops the
 * list's pages and starts over.
 */
const useList = <T,>(opts: {
  key: QueryKey
  staleTime: number
  enabled?: boolean
  fetch: (cursor: string | undefined) => Promise<Page<T>>
  identify: (item: T) => string
  read?: (item: T) => T
}): ListState<T> => {
  const qc = useQueryClient()
  const enabled = opts.enabled ?? true
  const q = useInfiniteQuery({
    queryKey: opts.key,
    staleTime: opts.staleTime,
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      try {
        return await opts.fetch(pageParam)
      } catch (e) {
        if (pageParam && codeOf(e) === 'CURSOR_INVALID') {
          // The cursor expired or was refused: start the list over from the first page.
          void qc.resetQueries({ queryKey: opts.key })
        }
        throw e
      }
    },
    getNextPageParam: last => (last.next.kind === 'more' ? (last.next.cursor as string) : undefined),
    refetchOnMount: false,
    ...policy,
  })
  const loaded = useMemo(() => {
    const seen = new Set<string>()
    const out: T[] = []
    for (const p of q.data?.pages ?? []) {
      for (const item of p.items) {
        const id = opts.identify(item)
        if (seen.has(id)) continue
        seen.add(id)
        out.push(item)
      }
    }
    return out
  }, [q.data])
  // Each item as the store has it now: merged counts and renamed authors re-render this list
  // only when one of its own items changed.
  const read = opts.read
  const items = useStoreSelector(() => (read ? loaded.map(read) : loaded), sameItems)

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = q
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [fetchNextPage, hasNextPage, isFetchingNextPage])

  // The latest options, so refresh keeps one identity across renders.
  const latest = useRef(opts)
  latest.current = opts
  const refreshing = useRef<Promise<void> | null>(null)
  const refresh = useCallback((): Promise<void> => {
    refreshing.current ??= (async () => {
      const { key, fetch, identify } = latest.current
      const data = qc.getQueryData<InfiniteData<Page<T>, string | undefined>>(key)
      if (!data?.pages.length) return void await qc.refetchQueries({ queryKey: key, exact: true })
      const first = await fetch(undefined)
      const fresh = new Set(first.items.map(identify))
      qc.setQueryData<InfiniteData<Page<T>, string | undefined>>(key, d => {
        const [head, ...rest] = d?.pages ?? []
        const overlaps = !!d?.pages.some(p => p.items.some(i => fresh.has(identify(i))))
        if (!d || !head || !overlaps) return { pages: [first], pageParams: [undefined] }
        // The new first page, then what's left of the old one; its cursor still leads on.
        const merged = { ...first, items: [...first.items, ...head.items.filter(i => !fresh.has(identify(i)))], next: head.next }
        return { pages: [merged, ...rest], pageParams: d.pageParams }
      })
    })().finally(() => { refreshing.current = null })
    return refreshing.current
  }, [qc])

  const last = q.data?.pages.at(-1)
  return {
    items,
    status: !enabled && !items.length ? 'idle' : q.isPending ? 'loading' : q.isError && !items.length ? 'error' : items.length ? 'ready' : 'empty',
    error: q.error ? toWarpError(q.error) : null,
    hasMore: !!hasNextPage,
    horizon: last?.next.kind === 'horizon',
    loadingMore: isFetchingNextPage,
    moreError: q.isFetchNextPageError ? toWarpError(q.error) : null,
    loadMore,
    refresh,
    incompleteBefore: q.data?.pages[0]?.incompleteBefore,
  }
}

export type FeedKind = { kind: 'channel'; key: string } | { kind: 'user'; fid: number; replies?: boolean }

/** A channel or profile feed, newest first, read through the entity store. */
export const useFeedScreen = (feed: FeedKind, opts: { enabled?: boolean } = {}): ListState<Cast> => {
  const { api, store } = useWarp()
  const o = feed.kind === 'channel'
    ? api.feed.channel.infiniteOptions({ key: feed.key as never })
    : api.feed.user.infiniteOptions({ fid: feed.fid as never, replies: feed.replies || undefined })
  return useList<Cast>({
    key: o.queryKey,
    staleTime: o.staleTime,
    enabled: opts.enabled,
    fetch: async cursor => {
      const page = await o.queryFn({ pageParam: cursor })
      store.mergeCasts(page.items, page.rev)
      return page
    },
    identify: c => c.hash,
    read: c => store.cast(c.hash) ?? c,
  })
}

/** A thread's head: the root cast (or its tombstone) and its ancestors, oldest first. */
export type ThreadHead = { root: CastOrTombstone; ancestors: Cast[] }

/** The thread's head, and its replies oldest first, 25 at a time. */
export type ThreadState = Read<ThreadHead> & { replies: ListState<Cast> }

export const useThreadScreen = (ref: { fid: number; hash: string }): ThreadState => {
  const { api, store } = useWarp()
  const input = { fid: ref.fid as never, hash: ref.hash as never }
  const thread = api.cast.thread.queryOptions(input)
  const head = useQuery({
    ...policy,
    queryKey: thread.queryKey,
    staleTime: thread.staleTime,
    queryFn: async () => {
      const t = await thread.queryFn()
      const live = t.root.state === 'live' ? [t.root.cast] : []
      store.mergeCasts([...live, ...t.ancestors, ...t.replies.items], t.replies.rev)
      return t
    },
  })
  const more = api.cast.thread.infiniteOptions(input)
  const replies = useList<Cast>({
    key: more.queryKey,
    staleTime: more.staleTime,
    enabled: head.isSuccess,
    fetch: async cursor => {
      if (!cursor && head.data) return head.data.replies
      const t = await more.queryFn({ pageParam: cursor })
      store.mergeCasts(t.replies.items, t.replies.rev)
      return t.replies
    },
    identify: c => c.hash,
    read: c => store.cast(c.hash) ?? c,
  })
  const root = head.data?.root
  const live = useStoreSelector(st => (root?.state === 'live' ? st.cast(root.cast.hash) ?? root.cast : undefined))
  const data = useMemo(() => (head.data && root
    ? { root: live ? { state: 'live' as const, cast: live } : root, ancestors: head.data.ancestors }
    : undefined), [head.data, root, live])
  return { ...toRead(head), data, replies }
}

/** A profile, and its casts. */
export type ProfileState = Read<User> & { feed: ListState<Cast> }

/** A profile by FID or username, and its casts. A username resolves to a FID first. */
export const useProfileScreen = (who: { fid: number } | { username: string }, opts: { replies?: boolean } = {}): ProfileState => {
  const { api } = useWarp()
  const byFid = 'fid' in who
  const o = byFid ? api.user.get.queryOptions({ fid: who.fid as never }) : api.user.byName.queryOptions({ username: who.username as never })
  const q = useQuery({ ...policy, queryKey: o.queryKey, staleTime: o.staleTime, queryFn: async () => (await o.queryFn()).user })
  const fid = q.data?.fid ?? (byFid ? who.fid : undefined)
  const feed = useFeedScreen({ kind: 'user', fid: fid ?? 0, replies: opts.replies ?? false }, { enabled: fid !== undefined })
  return { ...toRead(q), feed }
}

export const useChannel = (key: string, opts: { enabled?: boolean } = {}): Read<Channel> => {
  const { api, store } = useWarp()
  const o = api.channel.get.queryOptions({ key: key as never })
  const enabled = opts.enabled ?? true
  return toRead(useQuery({
    ...policy,
    queryKey: o.queryKey,
    enabled,
    staleTime: o.staleTime,
    queryFn: async () => {
      const { channel } = await o.queryFn()
      store.mergeChannels([channel])
      return channel
    },
  }), enabled)
}

/** Channels, most followed first. */
export const useChannels = (): ListState<Channel> => {
  const { api, store } = useWarp()
  const o = api.channel.list.infiniteOptions({})
  return useList<Channel>({
    key: o.queryKey,
    staleTime: o.staleTime,
    fetch: async cursor => {
      const page = await o.queryFn({ pageParam: cursor })
      store.mergeChannels(page.items)
      return page
    },
    identify: c => c.key,
  })
}

// The signed-in account (M1.5): sign-in, writes and the viewer overlay.

/** The account's state, loaded once per client, and its controller. */
export const useAccount = (): AccountState & { controller: WarpClient['account'] } => {
  const { account } = useWarp()
  const state = useSyncExternalStore(l => account.subscribe(l), () => account.current)
  useEffect(() => {
    if (account.current.kind === 'loading') void account.load()
  }, [account])
  return { ...state, controller: account }
}

/** The signed-in FID, or null. */
export const useViewerFid = (): number | null => {
  const a = useAccount()
  return a.kind === 'signedIn' ? a.fid : null
}

/** Loads the viewer's likes, recasts and follows into the overlay once signed in, and re-renders on change. */
export const useViewer = () => {
  const { api, viewer } = useWarp()
  const fid = useViewerFid()
  useQuery({
    ...policy,
    queryKey: mine(api.viewer.queryKey(), fid),
    enabled: fid !== null,
    staleTime: 60_000,
    queryFn: async () => {
      // All time, from the user object. While it is still loading the history, an absent
      // like or follow means "not known yet"; the overlay shows what is known.
      const [r, l] = await Promise.all([api.viewer.reactions({}), api.viewer.links({})])
      const v = { likes: r.likes, recasts: r.recasts, following: l.following }
      viewer.apply(v)
      return v
    },
  })
  useEffect(() => { if (fid === null) viewer.clear() }, [fid, viewer])
  useSyncExternalStore(l => viewer.subscribe(l), () => viewer.snapshot())
  return viewer
}

/** Casts from accounts the signed-in account follows, newest first. `idle` while signed out. */
export const useHomeFeed = (): ListState<Cast> => {
  const { api, store } = useWarp()
  const fid = useViewerFid()
  const o = api.feed.following.infiniteOptions({})
  return useList<Cast>({
    key: mine(o.queryKey, fid),
    staleTime: o.staleTime,
    enabled: fid !== null,
    fetch: async cursor => {
      const page = await o.queryFn({ pageParam: cursor })
      store.mergeCasts(page.items, page.rev)
      return page
    },
    identify: c => c.hash,
    read: c => store.cast(c.hash) ?? c,
  })
}

/** The signed-in account's inbox, grouped and newest first, 25 groups a page. */
export const useNotifications = (): ListState<Notification> => {
  const { api, store } = useWarp()
  const fid = useViewerFid()
  const o = api.notifications.list.infiniteOptions({})
  return useList<Notification>({
    key: mine(o.queryKey, fid),
    staleTime: o.staleTime,
    enabled: fid !== null,
    fetch: async cursor => {
      const page = await o.queryFn({ pageParam: cursor })
      store.mergeCasts(page.items.flatMap(n => (n.cast ? [n.cast] : [])), page.rev)
      return page
    },
    identify: n => n.id,
  })
}

/** How many notification groups are new since the account last looked: the tab's badge. */
export const useUnseenNotifications = (): Read<number> => {
  const { api } = useWarp()
  const fid = useViewerFid()
  const o = api.notifications.unseen.queryOptions({})
  return toRead(useQuery({
    ...policy,
    queryKey: mine(o.queryKey, fid),
    enabled: fid !== null,
    staleTime: o.staleTime,
    refetchInterval: 60_000,
    queryFn: async () => (await o.queryFn()).count as number,
  }), fid !== null)
}

/** Marks notifications up to a time as seen, and clears the badge. */
export const useMarkNotificationsSeen = (): Action<number, void> => {
  const { api } = useWarp()
  const fid = useViewerFid()
  const qc = useQueryClient()
  return useAction(async (upTo: number) => {
    if (fid === null) return ok(undefined)
    const key = mine(api.notifications.unseen.queryKey({}), fid)
    qc.setQueryData(key, 0)
    try {
      await api.notifications.markSeen({ upTo: upTo as never })
      return ok(undefined)
    } finally {
      void qc.invalidateQueries({ queryKey: key })
    }
  })
}

/** The signed-in account's custody and keys, fresh from the node. */
export const useAccountKeys = (): Read<{ custody: string; keys: AppKey[] }> => {
  const { api } = useWarp()
  const fid = useViewerFid()
  return toRead(useQuery({
    ...policy,
    queryKey: mine(api.signer.queryKey(), fid),
    enabled: fid !== null,
    staleTime: 0,
    queryFn: async () => {
      const [list, reg] = await Promise.all([api.signer.list({}), api.signer.registration({ fid: fid as never, key: `0x${'00'.repeat(32)}` })])
      return { custody: reg.custody, keys: list.signers }
    },
  }), fid !== null)
}

/**
 * Whether a write's change should stay on screen: it merged, or the node took it and it hasn't
 * been seen merging yet. Only a refused or unsent write is undone.
 */
const kept = (r: Result<unknown, WarpError>) => r.ok || r.error.kind === 'unconfirmed'

const done = (r: Result<unknown, WarpError>): Result<void, WarpError> => (r.ok ? ok(undefined) : r)

/**
 * Like and recast a cast, applied on screen at once and undone if the write fails. One write
 * per kind at a time: a tap while one is in flight is refused, so quick taps can't race.
 */
export const useCastActions = (cast: Pick<Cast, 'fid' | 'hash'>): { like: Toggle; recast: Toggle } => {
  const { account, store } = useWarp()
  const viewer = useViewer()
  const toggle = (kind: 'like' | 'recast') => async (): Promise<Result<void, WarpError>> => {
    const on = !viewer.has(kind, cast.hash)
    const token = viewer.set(kind, cast.hash, on)
    const change = store.pendCounts(cast.hash, { [kind === 'like' ? 'likes' : 'recasts']: on ? 1 : -1 })
    const r = await account.write({ type: on ? 'reactionAdd' : 'reactionRemove', reaction: kind, target: { fid: cast.fid, hash: cast.hash } })
    if (r.ok) store.mergedCounts(cast.hash, change)
    if (!kept(r)) {
      viewer.forget(kind, cast.hash, token)
      store.dropCounts(cast.hash, change)
    }
    return done(r)
  }
  const like = useAction(toggle('like'))
  const recast = useAction(toggle('recast'))
  return {
    like: { on: viewer.has('like', cast.hash), toggle: () => like.run(undefined), busy: like.busy, error: like.error },
    recast: { on: viewer.has('recast', cast.hash), toggle: () => recast.run(undefined), busy: recast.busy, error: recast.error },
  }
}

/** Follow and unfollow an account. `known` is false until the account's follows have loaded. */
export const useFollow = (fid: number): Toggle & { known: boolean } => {
  const { account } = useWarp()
  const viewer = useViewer()
  const a = useAction(async () => {
    const on = !viewer.has('follow', fid)
    const token = viewer.set('follow', fid, on)
    const r = await account.write({ type: on ? 'linkAdd' : 'linkRemove', targetFid: fid })
    if (!kept(r)) viewer.forget('follow', fid, token)
    return done(r)
  })
  return { on: viewer.has('follow', fid), toggle: () => a.run(undefined), busy: a.busy, error: a.error, known: viewer.loaded }
}

/** Reloads the queries under these key prefixes, leaving the rest of the cache alone. */
const refresh = (qc: QueryClient, prefixes: QueryKey[]) => Promise.all(prefixes.map(queryKey => qc.invalidateQueries({ queryKey })))

/**
 * Posts a draft: mentions resolved, links embedded, the phrase guard applied. Resolves to the
 * cast's hash once the network has merged it, and the lists it can appear in reload.
 */
export const useComposer = (): Action<Draft, string> => {
  const { api, account, store } = useWarp()
  const qc = useQueryClient()
  return useAction(async (draft: Draft) => {
    // Checked before mention lookups, so a phrase never reaches even a username request.
    if (looksLikePhrase(draft.text)) return account.write({ type: 'castAdd', text: draft.text })
    const problem = draftProblem(draft)
    if (problem) return err(warpError('invalid', problem))
    // A signed image URL can never change, so the composer signs only images this deployment
    // stored: https URLs of posted images on its own media origin.
    const caps = await qc.fetchQuery(api.meta.capabilities.queryOptions({}))
    const media = caps.origins.media
    if ((draft.images ?? []).some(u => !media || !u.startsWith(`${media}/img/u/`))) {
      return err(warpError('invalid', 'That image isn\'t stored on this server; attach it again.'))
    }
    const body = await prepareCast(draft, async username => (await api.user.byName({ username: username as never })).user.fid)
    const r = await account.write(body)
    if (r.ok) {
      if (draft.parent && 'hash' in draft.parent) store.mergedCounts(draft.parent.hash, store.pendCounts(draft.parent.hash, { replies: 1 }))
      // Merged means ingestion has folded it into the index already: the lists it can appear in reload.
      void refresh(qc, [api.feed.queryKey(), api.cast.thread.queryKey()])
    }
    return r
  })
}

/** Deletes one of the account's own casts, by hash. */
export const useDeleteCast = (): Action<string, string> => {
  const { api, account } = useWarp()
  const qc = useQueryClient()
  return useAction(async (hash: string) => {
    const r = await account.write({ type: 'castRemove', hash })
    if (r.ok) void refresh(qc, [api.feed.queryKey(), api.cast.queryKey()])
    return r
  })
}

/** Saves changed profile fields, one signed message each. */
export const useProfileEditor = (): Action<Partial<Record<UserDataField, string>>, void> => {
  const { api, account } = useWarp()
  const qc = useQueryClient()
  return useAction(async changes => {
    for (const [field, value] of Object.entries(changes) as [UserDataField, string][]) {
      const r = await account.write({ type: 'userDataAdd', field, value })
      if (!r.ok) return r
    }
    void refresh(qc, [api.user.queryKey(), api.signer.queryKey()])
    return ok(undefined)
  })
}

/** One live cast; `null` when it's gone. */
export const useCast = (ref: { fid: number; hash: string } | null): Read<Cast | null> => {
  const { api, store } = useWarp()
  const o = api.cast.get.queryOptions({ fid: ref?.fid as never, hash: ref?.hash as never })
  return toRead(useQuery({
    ...policy,
    queryKey: o.queryKey,
    enabled: !!ref,
    staleTime: o.staleTime,
    queryFn: async () => {
      const r = await o.queryFn()
      if (r.cast.state !== 'live') return null
      store.mergeCasts([r.cast.cast], r.rev)
      return r.cast.cast
    },
  }), !!ref)
}

/** A full profile by FID; `idle` for null. */
export const useUser = (fid: number | null): Read<User> => {
  const { api } = useWarp()
  const o = api.user.get.queryOptions({ fid: fid as never })
  return toRead(useQuery({ ...policy, queryKey: o.queryKey, enabled: fid !== null, staleTime: o.staleTime, queryFn: async () => (await o.queryFn()).user }), fid !== null)
}

/**
 * Resolves what someone typed, a FID or a username with or without @, to a FID. Text that
 * looks like a recovery phrase is refused (`phrase`) before anything is sent; text that isn't
 * a username is `invalid`; a name nobody has is `notFound`.
 */
export const useLookupFid = (): Action<string, number> => {
  const { api } = useWarp()
  return useAction(async (typed: string) => {
    if (looksLikePhrase(typed)) return err(warpError('phrase', 'That looks like a recovery phrase. Type your username or FID instead; the phrase goes only in the vault\'s own screen.'))
    const raw = typed.trim().replace(/^@/, '').toLowerCase()
    if (/^[1-9]\d{0,15}$/.test(raw)) return ok(Number(raw))
    if (!parseFname(raw).ok) return err(warpError('invalid', 'Enter a Farcaster username or FID.'))
    try {
      return ok((await api.user.byName({ username: raw as never })).user.fid)
    } catch (e) {
      const f = toWarpError(e)
      return err(f.kind === 'notFound' ? warpError('notFound', 'No account has that username.') : f)
    }
  })
}

/**
 * The deployment's media origin, if it serves images. Images are only ever loaded from here:
 * the server fetched and re-encoded them, so the phone never contacts a URL someone posted.
 */
export const useMediaOrigin = (): string | null => {
  const { api } = useWarp()
  const q = useQuery({ ...policy, ...api.meta.capabilities.queryOptions({}) })
  return q.data?.origins.media ?? null
}

/**
 * The account's media token, which a private media origin needs on avatar and image URLs.
 * One token serves every user for a day. Undefined while it loads; null when there's none
 * (signed out, or a public deployment that hands none out).
 */
const useMediaToken = (): string | null | undefined => {
  const { api } = useWarp()
  const fid = useViewerFid()
  const o = api.session.media.queryOptions({})
  const q = useQuery({ ...policy, ...o, queryKey: mine(o.queryKey, fid), enabled: fid !== null })
  if (fid === null) return null
  if (q.isPending) return undefined
  return q.data?.token ?? null
}

/** The URL of a stored image on the media origin; null when there's none to show (yet). */
export const useMediaUrl = (key: string | undefined | null): string | null => {
  const media = useMediaOrigin()
  const token = useMediaToken()
  if (!media || !key || !/^[a-z0-9][a-z0-9/._-]{0,511}$/.test(key) || token === undefined) return null
  return token ? `${media}/img/${key}?t=${encodeURIComponent(token)}` : `${media}/img/${key}`
}

/** What one of a cast's URL embeds is: an image, a link card or unknown, read once by the server. */
export const useEmbed = (ref: { fid: number; hash: string }, index: number, opts: { enabled?: boolean } = {}): Read<EmbedMetadata> => {
  const { api } = useWarp()
  const enabled = opts.enabled ?? true
  return toRead(useQuery({ ...policy, ...api.cast.embed.queryOptions({ fid: ref.fid as never, hash: ref.hash as never, index }), enabled }), enabled)
}

/**
 * Uploads a photo prepared on the device (a local file URI) and returns its URL on the media
 * origin, ready to embed. A refusal says why, in the server's words.
 */
export const useUploadPhoto = (): Action<string, { url: string; width: number; height: number }> => {
  const { api } = useWarp()
  return useAction(async (uri: string) => {
    try {
      const blob = await (await fetch(uri)).blob()
      // The contract takes a File; fetch gives a Blob, on React Native as on the web.
      const file = new File([blob], 'photo.jpg', { type: blob.type || 'image/jpeg' })
      return ok(await api.media.upload(file))
    } catch (e) {
      const reason = typeof e === 'object' && e !== null && 'data' in e ? (e as { data?: { reason?: unknown } }).data?.reason : undefined
      const f = toWarpError(e)
      return err(typeof reason === 'string' ? { ...f, message: reason } : { ...f, message: 'The photo couldn\'t be uploaded. Try again.' })
    }
  })
}

/**
 * The channels this account follows, kept on the device. The first load imports them from
 * Farcaster; follows and unfollows after that stay here.
 */
export const useFollowedChannels = () => {
  const { channels, origin } = useWarp()
  const fid = useViewerFid()
  const state = useSyncExternalStore(l => channels.subscribe(l), () => channels.snapshot())
  useEffect(() => {
    if (fid === null) channels.reset()
    else void channels.load(origin, fid)
  }, [channels, origin, fid])
  return {
    state,
    isFollowing: (key: string) => state.kind === 'ready' && state.channels.some(c => c.key === key),
    follow: (c: { key: string; name: string; url: string; image?: string | undefined }) => channels.follow(c),
    unfollow: (key: string) => channels.unfollow(key),
    reimport: () => channels.reimport(),
  }
}
