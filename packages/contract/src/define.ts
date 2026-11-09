import { defineMeta, oc, type AnySchema } from '@orpc/contract'
import { openapi } from '@orpc/openapi'
import { z } from 'zod'
import { errors, type ErrorCode } from './errors.ts'
import type { Module } from './entities.ts'

// A route is five facts: what it does, where
// it lives, who may call it, how fresh its answer must be, and what a miss costs. Method,
// cache scope, Cache-Control, staleTime, the rate-limit class and the base errors are all
// derived, so an unsafe combination can't be written: a public read is shared because it is
// public, and nothing else can be marked shared. This file is the only one that touches
// oRPC's contract API, so a change in the pinned beta is a change here.

/**
 * One credential scheme per route: `none` reads no credential, and its
 * handler has no session; `session` takes a bearer session token, and its handler gets the
 * session's FID and user object; `message` is `messages.submit`, whose signed message is the
 * credential, plus a session for every type but `KEY_ADD`.
 */
export type Auth = 'none' | 'session' | 'message' | { capability: 'notify' | 'link' }
export type Fresh = '0s' | '10s' | '30s' | '60s' | '5m' | '1h' | '1d' | '3d'
/** What a miss costs: CPU only, one bounded D1 query, one Durable Object call, or a Snapchain or provider call. */
export type Cost = 'worker' | 'db' | 'object' | 'upstream'

export type Facts = {
  kind: 'read' | 'write'
  path: `/api/${string}`
  auth: Auth
  fresh: Fresh
  cost: Cost
  module: Module
  /** Takes a cursor and returns a page. */
  paged: boolean
}

export const [factsMeta, getFacts] = defineMeta('ws/facts', (incoming: Facts) => incoming)

const FRESH_SECONDS: Record<Fresh, number> = { '0s': 0, '10s': 10, '30s': 30, '60s': 60, '5m': 300, '1h': 3_600, '1d': 86_400, '3d': 259_200 }
export const freshSeconds = (f: Fresh): number => FRESH_SECONDS[f]

/** Who may share the answer follows from auth: reads with no credential are shared, every other read is private. */
export const cacheControlOf = (f: Pick<Facts, 'kind' | 'auth' | 'fresh'>): string => {
  const s = FRESH_SECONDS[f.fresh]
  if (f.kind === 'write' || s === 0) return 'no-store'
  return f.auth === 'none' ? `public, max-age=${s}, stale-while-revalidate=${s}` : `private, max-age=${s}`
}

/** Base errors every route gets from its facts. */
export const baseErrorsOf = (f: Pick<Facts, 'kind' | 'auth' | 'cost' | 'module' | 'paged'>): ErrorCode[] => [
  'RATE_LIMITED', 'BAD_INPUT',
  ...(f.auth !== 'none' ? ['UNAUTHORIZED'] as const : []),
  // A session route can fail when no node answers the user object's signer recheck.
  ...(f.auth === 'session' && f.cost !== 'upstream' ? ['UPSTREAM_UNAVAILABLE'] as const : []),
  ...(f.kind === 'write' ? ['READ_ONLY'] as const : []),
  ...(f.cost === 'upstream' ? ['UPSTREAM_UNAVAILABLE'] as const : []),
  ...(f.module !== 'core' ? ['MODULE_DISABLED'] as const : []),
  ...(f.paged ? ['CURSOR_INVALID'] as const : []),
]

type Base<A extends Auth, C extends Cost, P extends boolean> =
  | 'RATE_LIMITED' | 'BAD_INPUT'
  | (A extends 'none' ? never : 'UNAUTHORIZED')
  | (C extends 'upstream' ? 'UPSTREAM_UNAVAILABLE' : A extends 'session' ? 'UPSTREAM_UNAVAILABLE' : never)
  | (P extends true ? 'CURSOR_INVALID' : never)

const pick = <K extends ErrorCode>(keys: readonly K[]): Pick<typeof errors, K> =>
  Object.fromEntries([...new Set(keys)].map(k => [k, errors[k]])) as Pick<typeof errors, K>

type ReadDef<A extends 'none' | 'session', I extends AnySchema, O extends AnySchema, E extends ErrorCode, C extends Cost, P extends boolean> = {
  path: `/api/${string}`
  auth: A
  fresh: Fresh
  cost: C
  module?: Module
  paged?: P
  input?: I
  output: O
  errors?: readonly E[]
}

const NoInput = z.object({})

/**
 * A read: GET, cached by its `fresh`. With auth `none` it has no viewer in the handler's
 * context and is shared by every viewer; with auth `session` it is private to the session.
 */
export const read = <O extends AnySchema, A extends 'none' | 'session' = 'none', I extends AnySchema = typeof NoInput, E extends ErrorCode = never, C extends Cost = Cost, P extends boolean = false>(
  def: ReadDef<A, I, O, E, C, P>,
) => {
  const facts: Facts = {
    kind: 'read', path: def.path, auth: def.auth, fresh: def.fresh, cost: def.cost,
    module: def.module ?? 'core', paged: def.paged ?? false,
  }
  return oc
    .meta(
      openapi({
        method: 'GET',
        path: def.path,
        // The facts appear in the OpenAPI document as x-warpstack-* extensions.
        spec: op => ({ ...op, 'x-warpstack-auth': facts.auth, 'x-warpstack-fresh': facts.fresh, 'x-warpstack-cost': facts.cost }),
      }),
      factsMeta(facts),
    )
    .errors(pick<E | Base<A, C, P>>([...baseErrorsOf(facts), ...(def.errors ?? [])] as (E | Base<A, C, P>)[]))
    .input((def.input ?? NoInput) as I)
    .output(def.output)
}

type WriteDef<I extends AnySchema, O extends AnySchema, E extends ErrorCode> = {
  path: `/api/${string}`
  /** The request carries a signed Farcaster message, which is its credential, plus a session for every type but `KEY_ADD`. */
  auth: 'message'
  input: I
  output: O
  errors?: readonly E[]
}

/**
 * A write: POST, never cached, limited per IP, and allowed to reach the node. Its
 * credential is the signed message in the body; the handler verifies it before anything else.
 */
export const write = <O extends AnySchema, I extends AnySchema, E extends ErrorCode = never>(def: WriteDef<I, O, E>) => {
  const facts: Facts = { kind: 'write', path: def.path, auth: def.auth, fresh: '0s', cost: 'upstream', module: 'core', paged: false }
  return oc
    .meta(
      openapi({
        method: 'POST',
        path: def.path,
        spec: op => ({ ...op, 'x-warpstack-auth': facts.auth, 'x-warpstack-fresh': facts.fresh, 'x-warpstack-cost': facts.cost }),
      }),
      factsMeta(facts),
    )
    .errors(pick<E | 'RATE_LIMITED' | 'BAD_INPUT' | 'UNAUTHORIZED' | 'READ_ONLY' | 'UPSTREAM_UNAVAILABLE'>([...baseErrorsOf(facts), ...(def.errors ?? [])] as never))
    .input(def.input)
    .output(def.output)
}

type CallDef<A extends 'none' | 'session', I extends AnySchema, O extends AnySchema, E extends ErrorCode, C extends Cost> = {
  path: `/api/${string}`
  auth: A
  cost: C
  module?: Module
  input?: I
  output: O
  errors?: readonly E[]
}

type CallBase<A extends Auth, C extends Cost> =
  | 'RATE_LIMITED' | 'BAD_INPUT' | 'READ_ONLY'
  | (A extends 'none' ? never : 'UNAUTHORIZED')
  | (C extends 'upstream' ? 'UPSTREAM_UNAVAILABLE' : A extends 'session' ? 'UPSTREAM_UNAVAILABLE' : never)

/**
 * A call that isn't a signed message: POST, never cached, limited per IP. Session routes
 * (`session.end`) and the stateless steps before a session exists (`session.challenge`,
 * `session.verify`, `signer.request`).
 */
export const call = <O extends AnySchema, A extends 'none' | 'session' = 'none', I extends AnySchema = typeof NoInput, E extends ErrorCode = never, C extends Cost = Cost>(
  def: CallDef<A, I, O, E, C>,
) => {
  const facts: Facts = { kind: 'write', path: def.path, auth: def.auth, fresh: '0s', cost: def.cost, module: def.module ?? 'core', paged: false }
  return oc
    .meta(
      openapi({
        method: 'POST',
        path: def.path,
        spec: op => ({ ...op, 'x-warpstack-auth': facts.auth, 'x-warpstack-fresh': facts.fresh, 'x-warpstack-cost': facts.cost }),
      }),
      factsMeta(facts),
    )
    .errors(pick<E | CallBase<A, C> | 'MODULE_DISABLED'>([...baseErrorsOf(facts), ...(def.errors ?? [])] as (E | CallBase<A, C>)[]))
    .input((def.input ?? NoInput) as I)
    .output(def.output)
}
