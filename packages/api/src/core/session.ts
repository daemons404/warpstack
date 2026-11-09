import { fromBase64Url, fromHex, toBase64Url, toHex } from '@warpstack/protocol'
import type { Mac } from '../ports.ts'

// Session challenges and tokens, as pure functions over a MAC and bytes
// the caller supplies. Nothing here touches storage, time or randomness.
//
// A challenge is `{nonce}.{expiresAt}.{mac}`, the MAC over the nonce, FID, key, the
// deployment's canonical origin and the expiry, so `session.verify` can check it without
// having stored anything. A token is `{fid}.{random}.{mac}`: the Worker checks the MAC before
// routing to the user object the token names, and the object checks the token's hash.

export const CHALLENGE_TTL = 5 * 60
export const SESSION_TTL = 24 * 60 * 60
/** How long a user object trusts its last read of the key and custody (`SIGNER_RECHECK`). */
export const SIGNER_RECHECK = 10 * 60
/** How long session routes keep working when no node answers a recheck (`SIGNER_STALE_MAX`). */
export const SIGNER_STALE_MAX = 60 * 60

const challengeData = (c: { fid: number; key: string; origin: string; nonce: string; expiresAt: number }) =>
  `ws-challenge-v1|${c.fid}|${c.key}|${c.origin}|${c.nonce}|${c.expiresAt}`

export const makeChallenge = async (mac: Mac, c: { fid: number; key: string; origin: string; nonce: Uint8Array; now: number }) => {
  const nonce = toHex(c.nonce)
  const expiresAt = c.now + CHALLENGE_TTL
  const tag = await mac.sign(challengeData({ ...c, nonce, expiresAt }))
  return { challenge: `${toBase64Url(c.nonce)}.${expiresAt}.${tag}`, nonce, expiresAt }
}

export type ChallengeError = 'malformed' | 'forged' | 'expired'

/** The challenge's nonce, if the MAC holds for this FID, key and origin and it hasn't expired. */
export const openChallenge = async (mac: Mac, c: { challenge: string; fid: number; key: string; origin: string; now: number }):
  Promise<{ ok: true; nonce: Uint8Array; expiresAt: number } | { ok: false; error: ChallengeError }> => {
  const parts = c.challenge.split('.')
  if (parts.length !== 3) return { ok: false, error: 'malformed' }
  const [n, e, tag] = parts as [string, string, string]
  const nonce = fromBase64Url(n)
  const expiresAt = /^[0-9]{1,12}$/.test(e) ? Number(e) : NaN
  if (!nonce || nonce.length !== 32 || !Number.isSafeInteger(expiresAt)) return { ok: false, error: 'malformed' }
  if (!(await mac.verify(challengeData({ fid: c.fid, key: c.key, origin: c.origin, nonce: toHex(nonce), expiresAt }), tag))) {
    return { ok: false, error: 'forged' }
  }
  if (expiresAt <= c.now) return { ok: false, error: 'expired' }
  return { ok: true, nonce, expiresAt }
}

const tokenData = (fid: number, random: string) => `ws-session-v1|${fid}|${random}`

export const makeToken = async (mac: Mac, fid: number, random: Uint8Array): Promise<string> => {
  const r = toBase64Url(random)
  return `${fid}.${r}.${await mac.sign(tokenData(fid, r))}`
}

/** The FID a token names, if its MAC holds. Only then may a request reach that user's object. */
export const tokenFid = async (mac: Mac, token: string): Promise<number | null> => {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [f, r, tag] = parts as [string, string, string]
  if (!/^[1-9][0-9]{0,15}$/.test(f) || !/^[A-Za-z0-9_-]{43}$/.test(r)) return null
  const fid = Number(f)
  if (!Number.isSafeInteger(fid)) return null
  return (await mac.verify(tokenData(fid, r), tag)) ? fid : null
}

/** The bearer token from an Authorization header, or null. */
export const bearer = (header: string | null | undefined): string | null => {
  const m = header?.match(/^Bearer ([A-Za-z0-9_.-]{1,256})$/)
  return m ? m[1]! : null
}

export const keyBytes = (key: string): Uint8Array | null => fromHex(key, 32)
