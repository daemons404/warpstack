import { err, ok, toBase64Url, verifySession, type Fid, type Result } from '@warpstack/protocol'
import { admits, type Admission } from './config.ts'
import { keyBytes, makeChallenge, makeToken, openChallenge, tokenFid } from './core/session.ts'
import type { Clock, Mac, Random, Snapchain, Sql } from './ports.ts'
import type { UserApi } from './user-object.ts'
import { readSignerCheck } from './user-store.ts'

// Sessions on the Worker side: stateless challenges, verification, and
// authentication of bearer tokens. The user object is reached only from here, and only after a
// signature or MAC check, so no unauthenticated request ever wakes one.

export type SessionError =
  | { kind: 'challenge' }
  | { kind: 'origin' }
  | { kind: 'signature' }
  | { kind: 'key_inactive' }
  | { kind: 'not_accepted' }
  | { kind: 'session' }
  | { kind: 'upstream'; detail: string }
  | { kind: 'read_only' }

/** A verified session: the FID and its user object, which only `authenticate` hands out. */
export type SessionContext = { fid: Fid; user: UserApi; tokenHash: string }

export type SessionDeps = {
  mac: Mac
  random: Random
  clock: Clock
  snapchain: Snapchain
  db: Sql
  /** The user object for a FID. Called only after a check passes. */
  users: (fid: number) => UserApi
  /** The deployment's canonical origin, which signed challenges must name. */
  origin: string
  /** `any`: any key active for the FID; `appFid`: only keys the deployment's app FID requested. */
  acceptKeysFrom: { kind: 'any' } | { kind: 'appFid'; fid: number }
  /** Who may open a session at all (config's ACCESS, ALLOWED_FIDS and APP_FID). */
  admission: Admission
  readOnly: boolean
}

const sha256Hex = async (s: string): Promise<string> => {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return [...d].map(b => b.toString(16).padStart(2, '0')).join('')
}

export class Sessions {
  constructor(private readonly d: SessionDeps) {}

  challenge(fid: Fid, key: string) {
    return makeChallenge(this.d.mac, { fid, key, origin: this.d.origin, nonce: this.d.random.bytes(32), now: this.d.clock.now() })
  }

  /**
   * Checks the challenge's MAC and expiry, the signature over this deployment's origin, and
   * the key and custody fresh from the node. Only then does it record the FID as a user and ask
   * its user object to record the nonce and store the session.
   */
  async verify(v: { fid: Fid; key: string; challenge: string; signature: string; device?: string | undefined }):
    Promise<Result<{ token: string; expiresAt: number }, SessionError>> {
    if (this.d.readOnly) return err({ kind: 'read_only' })
    const now = this.d.clock.now()
    const c = await openChallenge(this.d.mac, { challenge: v.challenge, fid: v.fid, key: v.key, origin: this.d.origin, now })
    if (!c.ok) return err({ kind: 'challenge' })
    // With only a list of FIDs, an unlisted FID is refused before anything asks the node.
    const a = this.d.admission
    if (!a.public && a.appFid === undefined && !a.allowed.has(v.fid)) return err({ kind: 'not_accepted' })
    const key = keyBytes(v.key)
    const sig = hexBytes(v.signature)
    if (!key || !sig || sig.length !== 64 || !verifySession(key, this.d.origin, c.nonce, sig)) return err({ kind: 'signature' })

    // The key's state and the custody, fresh from the node: a session never outlives either.
    const check = await readSignerCheck(this.d.snapchain, v.fid, now)
    if (!check) return err({ kind: 'upstream', detail: 'no node answered the signer read' })
    if (!check.keys.has(v.key) || !check.custody) return err({ kind: 'key_inactive' })
    if (this.d.acceptKeysFrom.kind === 'appFid' && check.requestFids.get(v.key) !== this.d.acceptKeysFrom.fid) return err({ kind: 'not_accepted' })
    // Signing in proves who you are, not that you're invited: a private deployment admits only allowed FIDs.
    if (!admits(this.d.admission, v.fid, check.requestFids.get(v.key))) return err({ kind: 'not_accepted' })

    // Membership first, so ingestion queues the user's steps from before the backfill reads.
    await this.d.db.batch([{ sql: 'INSERT INTO members (fid, joined_ts) VALUES (?1, ?2) ON CONFLICT DO NOTHING', params: [v.fid, now] }])
    const token = await makeToken(this.d.mac, v.fid, this.d.random.bytes(32))
    const opened = await this.d.users(v.fid).openSession(v.fid, {
      nonce: toBase64Url(c.nonce), nonceExpires: c.expiresAt, tokenHash: await sha256Hex(token), appKey: v.key,
      device: v.device ?? `anon-${toBase64Url(this.d.random.bytes(12))}`, custody: check.custody, now,
      requestFid: check.requestFids.get(v.key),
    })
    if (!opened.ok) return err({ kind: 'challenge' })
    return ok({ token, expiresAt: opened.expiresAt })
  }

  /** The session a bearer token names: the MAC is checked here, the hash and expiry by the object. */
  async authenticate(token: string | null): Promise<Result<SessionContext, SessionError>> {
    if (!token) return err({ kind: 'session' })
    const fid = await tokenFid(this.d.mac, token)
    if (fid === null) return err({ kind: 'session' })
    // A FID taken off ALLOWED_FIDS loses its sessions at once. Without an app FID that's known
    // before the user object is woken.
    const a = this.d.admission
    if (!a.public && a.appFid === undefined && !a.allowed.has(fid)) return err({ kind: 'session' })
    const user = this.d.users(fid)
    const tokenHash = await sha256Hex(token)
    const r = await user.authenticate(fid, tokenHash)
    if (!r.ok) return err(r.reason === 'upstream' ? { kind: 'upstream', detail: 'no node answered the signer recheck' } : { kind: 'session' })
    // With an app FID, a session stays admitted only while its FID is listed or its key is the app's.
    if (!admits(a, fid, r.requestFid ?? undefined)) return err({ kind: 'session' })
    return ok({ fid: fid as Fid, user, tokenHash })
  }
}

const hexBytes = (h: string): Uint8Array | null => {
  if (!/^0x([0-9a-f]{2})+$/.test(h)) return null
  return Uint8Array.from(h.slice(2).match(/../g)!.map(b => parseInt(b, 16)))
}
