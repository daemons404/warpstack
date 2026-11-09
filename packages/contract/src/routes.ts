import { ProcedureContract, type RouterContract } from '@orpc/contract'
import { contract } from './contract.ts'
import { getFacts, type Facts } from './define.ts'
import { MEDIA_UPLOAD_MAX_BYTES } from './limits.ts'

// The route table: every route's facts with its method, found by method and path. The
// server reads it before decoding a request, so a request's limits, credential and body
// size are checked before a byte of its body is read; the client reads it to know which
// requests go without the session token.

export type Route = Facts & {
  method: 'GET' | 'POST'
  /** The largest body the route takes, in bytes: none for reads, the image for an upload. */
  maxBody: number
}

/** The largest JSON body any route takes: a signed message is at most 4,096 characters. */
export const BODY_MAX_BYTES = 16 * 1_024
/** Room for a multipart envelope around an upload's image. */
const UPLOAD_ENVELOPE = 64 * 1_024

/**
 * The routes that must work before a session exists: the handshake (`session.challenge`,
 * `session.verify`), first sign-in's key steps (`signers.*`) and the deployment's
 * capabilities. They never carry a session token, and a private deployment serves them to
 * anyone. None has a path parameter.
 */
const PRE_SESSION = /^\/api\/(session|signers)\/|^\/api\/meta$/

const collect = (node: RouterContract, out: Route[]) => {
  if (node instanceof ProcedureContract) {
    const f = getFacts(node) as Facts | undefined
    if (!f) throw new Error('a route without facts')
    const method = f.kind === 'read' ? 'GET' : 'POST'
    const maxBody = method === 'GET' ? 0 : f.path === UPLOAD_PATH ? MEDIA_UPLOAD_MAX_BYTES + UPLOAD_ENVELOPE : BODY_MAX_BYTES
    out.push({ ...f, method, maxBody })
    return
  }
  for (const child of Object.values(node)) collect(child as RouterContract, out)
}

const UPLOAD_PATH = (getFacts(contract.media.upload) as Facts).path

export const ROUTES: readonly Route[] = (() => {
  const out: Route[] = []
  collect(contract, out)
  return out
})()

export const PRE_SESSION_PATHS: ReadonlySet<string> = new Set(
  ROUTES.filter(r => r.auth === 'none' && PRE_SESSION.test(r.path)).map(r => r.path),
)

const escape = (s: string) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&')

/** Path templates as patterns; a fixed segment wins over a parameter (`/users/bulk` before `/users/{fid}`). */
const matchers = ROUTES
  .map(r => ({
    route: r,
    params: (r.path.match(/\{[^}]+\}/g) ?? []).length,
    re: new RegExp(`^${r.path.split(/\{[^}]+\}/).map(escape).join('[^/]+')}$`),
  }))
  .sort((a, b) => a.params - b.params)

/** The route a request names, or undefined. */
export const routeOf = (method: string, path: string): Route | undefined =>
  matchers.find(m => m.route.method === method && m.re.test(path))?.route
