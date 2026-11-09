import { err, ok, type Result } from '@warpstack/protocol'
import type { Mac } from '../ports.ts'

// Cursors: an opaque, base64url keyset position, MAC'd and
// bound to the route and its parameters, so an expired, foreign or tampered cursor is
// refused as CURSOR_INVALID instead of silently paging the wrong list.

export type Position =
  /** An index keyset position, newest first unless the route says otherwise. */
  | { k: 'idx'; ts: number; h: string }
  /** An upstream Snapchain page token, past the index. `b` is the boundary already served from the index. */
  | { k: 'up'; t: string; b?: number }
  /** A ranked list position: a count, descending, then a key, ascending (channels by followers). */
  | { k: 'rank'; n: number; key: string }
  /** An inbox position: a group's latest time, then its key (`like:0x…`, `follow:20000`), descending. */
  | { k: 'note'; ts: number; key: string }

const b64 = {
  encode: (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))),
}

const MAX_CURSOR = 512
/** An inbox group's key: a kind, then a message hash or, for follows, a day number. */
const GROUP_KEY = /^[a-z]{1,16}:(0x[0-9a-f]{40}|\d{1,10})$/

export const encodeCursor = async (mac: Mac, scope: string, p: Position): Promise<string> => {
  const body = b64.encode(JSON.stringify(p))
  return `${body}.${await mac.sign(`${scope}|${body}`)}`
}

export const decodeCursor = async (mac: Mac, scope: string, cursor: string): Promise<Result<Position, 'invalid'>> => {
  if (cursor.length > MAX_CURSOR) return err('invalid')
  const [body, sig, ...rest] = cursor.split('.')
  if (!body || !sig || rest.length) return err('invalid')
  if (!(await mac.verify(`${scope}|${body}`, sig))) return err('invalid')
  try {
    const p = JSON.parse(b64.decode(body)) as Position
    if (p.k === 'idx' && Number.isSafeInteger(p.ts) && /^0x[0-9a-f]{40}$/.test(p.h)) return ok(p)
    if (p.k === 'up' && typeof p.t === 'string' && p.t.length < 400) return ok(p)
    if (p.k === 'rank' && Number.isSafeInteger(p.n) && typeof p.key === 'string' && p.key.length <= 64) return ok(p)
    if (p.k === 'note' && Number.isSafeInteger(p.ts) && typeof p.key === 'string' && GROUP_KEY.test(p.key)) return ok(p)
  } catch {
    // fall through
  }
  return err('invalid')
}
