import { ed25519 } from '@noble/curves/ed25519.js'
import { concatBytes } from './bytes.ts'
import { err, ok, type Result } from './result.ts'

// Session challenges (`signSession`). An app key proves it
// holds the key by signing a server nonce for one deployment's origin. The preimage is
//
//   "warpstack-session-v1" ‖ u16be(len(origin)) ‖ origin ‖ nonce (32 bytes)
//
// It is at least 56 bytes and starts with a fixed ASCII prefix, so it can never be a 20-byte
// Farcaster message hash, and the length prefix makes it unambiguous for any origin. The
// phone's Rust core builds the same bytes itself (`wallet/native/rust/src/app_key.rs`); the
// vectors in session.test.ts and `wallet/vectors/native.json` pin both.

export const SESSION_PREFIX = 'warpstack-session-v1'
export const SESSION_NONCE_BYTES = 32
export const MAX_ORIGIN_BYTES = 255

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const PORT = '(?::(?:[1-9][0-9]{0,4}))?'
const HTTPS = new RegExp(`^https://${LABEL}(?:\\.${LABEL})*${PORT}$`)
const LOCAL = new RegExp(`^http://(?:localhost|127\\.0\\.0\\.1)${PORT}$`)

/**
 * A session origin: `https://host[:port]`, or `http://localhost[:port]` or
 * `http://127.0.0.1[:port]` for development, lowercase, with no path, at most 255 bytes.
 * A deployment accepts only its own canonical origin; this checks the shape both sides sign.
 */
export const parseSessionOrigin = (origin: unknown): Result<string, string> => {
  if (typeof origin !== 'string' || origin.length > MAX_ORIGIN_BYTES) return err('bad origin')
  if (!HTTPS.test(origin) && !LOCAL.test(origin)) return err('bad origin')
  const port = origin.match(/:([0-9]+)$/)?.[1]
  if (port !== undefined && Number(port) > 65_535) return err('bad origin')
  return ok(origin)
}

export const sessionPreimage = (origin: string, nonce: Uint8Array): Result<Uint8Array, string> => {
  const o = parseSessionOrigin(origin)
  if (!o.ok) return o
  if (nonce.length !== SESSION_NONCE_BYTES) return err('a session nonce is 32 bytes')
  const bytes = new TextEncoder().encode(o.value)
  return ok(concatBytes(new TextEncoder().encode(SESSION_PREFIX), Uint8Array.of(bytes.length >> 8, bytes.length & 0xff), bytes, nonce))
}

/** Whether `signature` is `key`'s strict Ed25519 signature over the session preimage. */
export const verifySession = (key: Uint8Array, origin: string, nonce: Uint8Array, signature: Uint8Array): boolean => {
  if (key.length !== 32 || signature.length !== 64) return false
  const pre = sessionPreimage(origin, nonce)
  if (!pre.ok) return false
  try {
    return ed25519.verify(signature, pre.value, key, { zip215: false })
  } catch {
    return false
  }
}
