import { contract, freshSeconds, getFacts, PRE_SESSION_PATHS, type Contract, type Facts } from '@warpstack/contract'
import { createContractClientFactory, ProcedureContract, type ContractRouterClient, type RouterContract } from '@orpc/contract'
import { OpenAPILink } from '@orpc/openapi/fetch'

/** A query key: the deployment's origin, the route's path, then its input. */
export type QueryKey = readonly unknown[]

/**
 * What each route adds for TanStack Query, with no
 * dependency on it: plain objects to pass to `useQuery`, `useInfiniteQuery` or `fetchQuery`.
 * Keys follow the route's path, so invalidating `api.feed.queryKey()` refreshes every feed, and
 * `staleTime` comes from the route's `fresh` fact, so the device and the server cache agree.
 */
export type RouteQueries<I, O> = {
  queryKey(input?: I): QueryKey
  queryOptions(input: I): { queryKey: QueryKey; queryFn: () => Promise<O>; staleTime: number }
  /** For a paged route: each page asks for the one after the last, until there's no `more`. */
  infiniteOptions(input: Omit<NonNullable<I>, 'cursor'>): {
    queryKey: QueryKey
    queryFn: (context: { pageParam: string | undefined }) => Promise<O>
    initialPageParam: string | undefined
    getNextPageParam: (last: O) => string | undefined
    staleTime: number
  }
}

type WithQueries<T> = T extends (...args: infer A) => Promise<infer O>
  ? T & RouteQueries<A[0], O>
  : { [K in keyof T]: WithQueries<T[K]> } & { queryKey(): QueryKey }

export type Api = WithQueries<ContractRouterClient<Contract>>

/** A response failed the contract's output schema: this app is older or newer than the server. Never retried. */
export class ContractError extends Error {
  readonly retryable = false
  constructor(readonly path: string, readonly issues: unknown) {
    super(`The server's response to ${path} didn't match this app's contract; update the app`)
  }
}

/** Where the session token comes from: the account controller, which renews it. */
export type SessionAuth = {
  token(): string | null
  /** Opens a new session; `null` if it can't. */
  renew(): Promise<string | null>
  /** Resolves once it's known whether there's an account, so the first requests don't go out without a token they should carry. */
  ready?(): Promise<void>
}

export type ApiOptions = {
  /** The deployment's origin, such as https://reader.example.app. */
  baseUrl: string
  fetch?: typeof fetch
  auth?: SessionAuth
}

/**
 * The paths that never carry the session token: the routes that must work before a session
 * exists (the contract's `PRE_SESSION_PATHS`). Every other request carries it when there is
 * one, because a private deployment gates its reads too; on a public deployment a token on a
 * public read is ignored.
 */
export { PRE_SESSION_PATHS }

/** Whether a response is the server saying the session is gone, so one re-verify may fix it. */
const sessionGone = async (res: Response): Promise<boolean> => {
  if (res.status !== 401) return false
  try {
    const body = await res.clone().json() as { data?: { reason?: unknown } }
    return body?.data?.reason === 'session'
  } catch {
    return false
  }
}

/**
 * Adds the session token to every API request but the pre-session ones, opening a session first
 * if there's none, and re-verifies once when the server says the session is gone. A second 401 is
 * returned as is.
 */
const withSession = (f: typeof fetch, auth: SessionAuth | undefined): typeof fetch => async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const path = new URL(url).pathname
  if (!auth || !path.startsWith('/api/') || PRE_SESSION_PATHS.has(path)) return f(input, init)
  await auth.ready?.()
  const send = (token: string | null) => {
    const headers = new Headers(init?.headers)
    if (token) headers.set('authorization', `Bearer ${token}`)
    return f(input, { ...init, headers })
  }
  const res = await send(auth.token() ?? await auth.renew())
  const replayable = init?.body === undefined || init?.body === null || typeof init.body === 'string'
  if (!replayable || !(await sessionGone(res))) return res
  return send(await auth.renew())
}

/**
 * Query strings in a canonical order, so the same request always has the same URL and so
 * the same cache key in Workers Cache.
 */
export const canonicalUrl = (url: string): string => {
  const u = new URL(url)
  const params = [...u.searchParams.entries()].sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
  u.search = new URLSearchParams(params).toString()
  return u.toString()
}

/**
 * The typed API client, built at runtime from the contract with no generated file.
 * Every route is a REST call through oRPC's OpenAPI link, and
 * every response is parsed with the contract's output schema into branded types; a
 * mismatch is a `ContractError`, never a silently wrong object. Inputs are checked the same
 * way before they're sent, as an `InputError`. Public routes carry no
 * credential, so they stay cacheable; session routes carry the token from `auth`.
 */
export const createApi = ({ baseUrl, fetch: f = (i, init) => fetch(i, init), auth }: ApiOptions): Api => {
  const authed = withSession(f, auth)
  const link = new OpenAPILink(contract, {
    origin: baseUrl.replace(/\/$/, ''),
    url: '/',
    fetch: (url, init) => authed(canonicalUrl(url), init),
  })
  return parsed(createContractClientFactory(link)(contract) as object, contract, new URL(baseUrl).origin) as Api
}

/** Input that fails the contract, refused before any request is made. Never retried. */
export class InputError extends Error {
  readonly code = 'BAD_INPUT'
  readonly retryable = false
  constructor(readonly path: string) {
    super(`Refused to send input that fails the contract for ${path}`)
  }
}

const nextCursor = (page: unknown): string | undefined => {
  const next = (page as { next?: { kind?: unknown; cursor?: unknown } } | null)?.next
  return next?.kind === 'more' && typeof next.cursor === 'string' ? next.cursor : undefined
}

const parsed = (client: object, node: RouterContract, origin: string, path: string[] = []): object => {
  const key = (input?: unknown): QueryKey => (input === undefined ? [origin, ...path] : [origin, ...path, input])
  if (node instanceof ProcedureContract) {
    const call = client as unknown as (input: unknown, options?: unknown) => Promise<unknown>
    const schemas = node['~orpc'].outputSchemas ?? []
    const inputs = node['~orpc'].inputSchemas ?? []
    const staleTime = staleTimeOf(node)
    const run = async (input: unknown, options?: unknown) => {
      // Inputs are checked here too, so nothing the contract would refuse ever leaves the
      // device (a mistyped field can hold anything, a recovery phrase included).
      for (const schema of inputs) {
        if ((await schema['~standard'].validate(input ?? {})).issues) throw new InputError(path.join('.'))
      }
      let out = await call(input, options)
      for (const schema of schemas) {
        const r = await schema['~standard'].validate(out)
        if (r.issues) throw new ContractError(path.join('.'), r.issues)
        out = r.value
      }
      return out
    }
    return Object.assign(run, {
      queryKey: key,
      queryOptions: (input: unknown) => ({ queryKey: key(input), queryFn: () => run(input), staleTime }),
      infiniteOptions: (input: object) => ({
        // Apart from the route's plain queries: pages are a different shape in the cache.
        queryKey: [...key(), 'pages', input],
        queryFn: ({ pageParam }: { pageParam: string | undefined }) => run(pageParam === undefined ? input : { ...input, cursor: pageParam }),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: nextCursor,
        staleTime,
      }),
    })
  }
  return new Proxy(client, {
    get(target, name) {
      if (name === 'queryKey' && !Object.hasOwn(node, name)) return () => key()
      if (typeof name !== 'string' || !Object.hasOwn(node, name)) return (target as Record<string | symbol, unknown>)[name]
      const value = (target as Record<string, unknown>)[name]
      return value ? parsed(value as object, (node as Record<string, RouterContract>)[name]!, origin, [...path, name]) : value
    },
  })
}

/** How long a route's response may be reused, from its `fresh` fact, in milliseconds. */
export const staleTimeOf = (route: RouterContract): number => {
  if (!(route instanceof ProcedureContract)) return 0
  const f = getFacts(route) as Facts | undefined
  return f ? freshSeconds(f.fresh) * 1_000 : 0
}
