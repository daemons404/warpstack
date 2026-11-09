import { z } from 'zod'

/**
 * One error map. Each route gets its base errors from its facts (see `define.ts`) and
 * declares only the ones specific to it. Anything else is a bug.
 */
export const errors = {
  BAD_INPUT: { message: 'The request failed its schema', data: z.object({ issues: z.array(z.object({ path: z.string().max(256), message: z.string().max(256) })).max(20) }) },
  RATE_LIMITED: { message: 'Rate limited', data: z.object({ retryAfter: z.number().int().min(1) }) },
  UNAUTHORIZED: { message: 'Unauthorized', data: z.object({ reason: z.enum(['signature', 'keyInactive', 'keyNotAccepted', 'capability', 'session', 'challenge', 'origin', 'fidMismatch']) }) },
  CLOCK_SKEW: { message: 'The device clock is wrong', data: z.object({ serverTime: z.number().int() }) },
  READ_ONLY: { message: 'The deployment is temporarily read-only' },
  UPSTREAM_UNAVAILABLE: { message: 'The Snapchain node is unavailable' },
  MODULE_DISABLED: { message: 'This deployment does not have that module', data: z.object({ module: z.string().max(32) }) },
  CURSOR_INVALID: { message: 'This cursor is expired, foreign or damaged; load the list from the start' },
  NOT_FOUND: { message: 'Not found' },
  /** A signed message the Worker or the node refused: bad signature, inactive key, duplicate, or a protocol rule. */
  REJECTED: { message: 'The message was refused', data: z.object({ reason: z.string().max(300) }) },
} as const

export type ErrorCode = keyof typeof errors

/** HTTP status per error code, for the server's handler and the OpenAPI generator alike. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  BAD_INPUT: 400,
  RATE_LIMITED: 429,
  UNAUTHORIZED: 401,
  CLOCK_SKEW: 401,
  READ_ONLY: 503,
  UPSTREAM_UNAVAILABLE: 503,
  MODULE_DISABLED: 501,
  CURSOR_INVALID: 400,
  NOT_FOUND: 404,
  REJECTED: 422,
}
