import { ContractError, InputError } from './api.ts'

// One error style for everything the client returns: every read, list and
// write reports a `WarpError` as data, never an exception a screen must classify itself.
// `kind` says what happened, `message` is ready to show, and `retryable` says whether trying
// again could help, so a screen offers "Try again" only when it might work.

export type WarpErrorKind =
  /** The server or the Snapchain node couldn't be reached, or is briefly unavailable. */
  | 'network'
  /** Too many requests; `retryAfter` says how long to wait. */
  | 'rateLimited'
  | 'notFound'
  /** The input was refused: by the contract, by the server, or by a check on the device. */
  | 'invalid'
  /** The server's response didn't match this app's contract: the app needs updating. */
  | 'update'
  /** The session or the key isn't accepted. */
  | 'unauthorized'
  /** The network refused a signed message. */
  | 'rejected'
  /** The deployment doesn't serve this, or is read-only for now. */
  | 'unavailable'
  /** Text that looks like a recovery phrase was stopped before it was sent. */
  | 'phrase'
  /** A request (a sign-in, a revocation) ran past its deadline. */
  | 'expired'
  /** Sent, but not yet seen merging: it may still go through. */
  | 'unconfirmed'
  /** The person cancelled. */
  | 'cancelled'

export type WarpError = {
  kind: WarpErrorKind
  message: string
  retryable: boolean
  /** Seconds, for `rateLimited`. */
  retryAfter?: number
  /** The server's error code, when there was one. */
  code?: string
}

const RETRYABLE: ReadonlySet<WarpErrorKind> = new Set(['network', 'rateLimited', 'unconfirmed'])

/** A `WarpError` of a kind, with `retryable` set from it. */
export const warpError = (kind: WarpErrorKind, message: string, more: { retryAfter?: number; code?: string } = {}): WarpError =>
  ({ kind, message, retryable: RETRYABLE.has(kind), ...more })

export const isWarpError = (e: unknown): e is WarpError =>
  typeof e === 'object' && e !== null && typeof (e as WarpError).kind === 'string' && typeof (e as WarpError).message === 'string' && typeof (e as WarpError).retryable === 'boolean'

export const codeOf = (e: unknown): string =>
  (typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '')

const dataOf = (e: unknown): { reason?: unknown; retryAfter?: unknown; module?: unknown } | undefined =>
  (typeof e === 'object' && e !== null && 'data' in e ? (e as { data?: never }).data : undefined)

/** Whatever a call threw, as a `WarpError`: server codes, contract mismatches and network failures. */
export const toWarpError = (e: unknown): WarpError => {
  if (isWarpError(e)) return e
  const code = codeOf(e)
  const data = dataOf(e)
  const reason = data?.reason
  const with_ = { code }
  switch (code) {
    case 'NOT_FOUND': return warpError('notFound', 'Not found.', with_)
    case 'RATE_LIMITED': {
      const after = Number(data?.retryAfter)
      return warpError('rateLimited', 'Too many requests; try again in a minute.', Number.isFinite(after) && after > 0 ? { ...with_, retryAfter: after } : with_)
    }
    case 'BAD_INPUT': return warpError('invalid', 'That input isn\'t valid.', with_)
    case 'CURSOR_INVALID': return warpError('invalid', 'This list expired; reload it.', with_)
    case 'REJECTED': return warpError('rejected', `The network refused it: ${String(reason ?? 'unknown reason')}`, with_)
    case 'UNAUTHORIZED':
      if (reason === 'keyInactive') return warpError('unauthorized', 'This phone\'s key is no longer active on Farcaster (it expired or was revoked). Sign out in Settings and sign in again.', with_)
      if (reason === 'keyNotAccepted') return warpError('unauthorized', 'This deployment doesn\'t accept sessions from this key.', with_)
      return warpError('unauthorized', 'Your session ended. Try again, or sign out and back in.', with_)
    case 'CLOCK_SKEW': return warpError('invalid', 'This phone\'s clock is wrong. Set it automatically in Settings.', with_)
    case 'READ_ONLY': return warpError('unavailable', 'This deployment is read-only right now.', with_)
    case 'MODULE_DISABLED': return warpError('unavailable', 'This deployment doesn\'t offer that.', with_)
    case 'UPSTREAM_UNAVAILABLE': return warpError('network', 'The Snapchain node is unavailable right now.', with_)
  }
  if (e instanceof ContractError) return warpError('update', 'This app is out of date; update it to keep going.')
  if (e instanceof InputError) return warpError('invalid', 'That input isn\'t valid.', { code: 'BAD_INPUT' })
  const status = typeof e === 'object' && e !== null && 'status' in e ? Number((e as { status: unknown }).status) : NaN
  if (status >= 400 && status < 500) return warpError('invalid', 'The server refused the request.')
  return warpError('network', 'Couldn\'t reach the server or the Snapchain node. Try again.')
}
