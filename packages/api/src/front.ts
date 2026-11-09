import { ERROR_STATUS, errors, PRE_SESSION_PATHS, routeOf, type ErrorCode, type Route } from '@warpstack/contract'
import { callerKey } from './core/ip.ts'
import { bearer } from './core/session.ts'

// The front door: what runs before oRPC decodes a request. The route
// comes from the contract's table, so its limits, its credential and its body size are known
// before a byte of the body is read, and an anonymous or oversized request is refused without
// being buffered.

/** The Rate Limiting bindings this deployment configures; the contract names none. */
export type Limiters = { READ_IP: RateLimit; UPSTREAM_IP: RateLimit; WRITE_FID: RateLimit }

/**
 * Rate-limit classes from `auth × cost`: every request is limited
 * per caller, and one that may reach the node is also held to the tighter upstream limit.
 * Bindings count per location and approximately; they curb abuse.
 */
export const limitsFor = (r: Pick<Route, 'kind' | 'cost'>): ('READ_IP' | 'UPSTREAM_IP')[] =>
  r.kind === 'write' || r.cost === 'upstream' ? ['READ_IP', 'UPSTREAM_IP'] : ['READ_IP']

/** Whether a route needs a session token before anything else is looked at. */
export const needsToken = (r: Route, access: 'private' | 'public'): boolean =>
  r.auth === 'session' || (access === 'private' && r.auth === 'none' && !PRE_SESSION_PATHS.has(r.path))

/** A contract error as oRPC would send it, for refusals made before oRPC runs. */
export const refusal = (code: ErrorCode, data?: unknown, headers: Record<string, string> = {}): Response => {
  const body = { defined: true, code, message: errors[code].message, ...(data === undefined ? {} : { data }) }
  return Response.json(body, { status: ERROR_STATUS[code], headers: { 'cache-control': 'no-store', ...headers } })
}

/** A request body, or null as soon as it passes `max` bytes: nothing past the limit is buffered. */
export const readUpTo = async (stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> => {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

const tooLarge = (max: number) =>
  refusal('BAD_INPUT', { issues: [{ path: '', message: `the body is over ${max} bytes` }] })

export type Admission =
  | { ok: true; route: Route; request: Request; caller: string }
  | { ok: false; response: Response }

/**
 * Admits a request: its route, its rate limits, a token where one is required, and its body
 * read up to the route's limit. The request returned has its body buffered (or dropped, for
 * reads) and is the one to serve.
 */
export const admit = async (req: Request, opts: { ip: string; access: 'private' | 'public'; limiters: Limiters }): Promise<Admission> => {
  const route = routeOf(req.method, new URL(req.url).pathname)
  if (!route) return { ok: false, response: refusal('NOT_FOUND') }
  const caller = callerKey(opts.ip)
  for (const binding of limitsFor(route)) {
    const { success } = await opts.limiters[binding].limit({ key: `${binding}:${caller}` })
    if (!success) return { ok: false, response: refusal('RATE_LIMITED', { retryAfter: 60 }, { 'retry-after': '60' }) }
  }
  // Only presence is checked here; the handler's middleware checks the token itself.
  if (needsToken(route, opts.access) && !bearer(req.headers.get('authorization'))) {
    return { ok: false, response: refusal('UNAUTHORIZED', { reason: 'session' }) }
  }
  if (route.maxBody === 0) {
    return { ok: true, route, caller, request: req.body ? new Request(req.url, { method: req.method, headers: req.headers }) : req }
  }
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (!Number.isFinite(declared) || declared > route.maxBody) return { ok: false, response: tooLarge(route.maxBody) }
  if (!req.body) return { ok: true, route, caller, request: req }
  const body = await readUpTo(req.body, route.maxBody)
  if (!body) return { ok: false, response: tooLarge(route.maxBody) }
  return { ok: true, route, caller, request: new Request(req.url, { method: req.method, headers: req.headers, body }) }
}
