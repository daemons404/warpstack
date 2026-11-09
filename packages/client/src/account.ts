import type { SignerRegistration } from '@warpstack/contract'
import {
  APP_KEY_TTL_SECONDS, equalBytes, err, fromHex, keyFingerprint, looksLikePhrase, ok, POSTING_SCOPES, toBase64Url, toFarcasterTime, toHex,
  type KeyAddBody, type MessageBody, type Result, type Timestamp,
} from '@warpstack/protocol'
import { ContractError, InputError, type Api } from './api.ts'
import { codeOf, toWarpError, warpError, type WarpError } from './errors.ts'

// The signed-in account: sign-in makes an app key on the
// phone and asks the phone's transient vault to approve it, through its native sheet; once the
// node lists the key, the key signs a session challenge for this deployment's origin and the
// server returns a session token. The token is renewed silently
// before it expires, sent only on session routes and `messages.submit`, and re-verified once
// on a 401. Writes are signed by the key and submitted with the session; sign-out ends the
// session and revokes the key. The key store and the vault are ports, so the same controller
// runs against the native module on the phone and in-memory fakes in tests. Browsers stay
// read-only until they can be linked from the phone.
//
// Key operations are done only once the node shows them: it admits a `KEY_ADD` or
// `KEY_REMOVE` to its mempool and checks custody and nonces when it merges, so a 200 from
// submit proves nothing. A pending sign-in is kept with its key, so a relaunch resumes it, and
// every call names the key it expects.
//
// Renewal adds before it forgets: the replacement key waits in the key store as `next` while
// the current key keeps posting, and takes its place once the node lists it. Cancelling
// changes nothing.

export type PendingSignIn = { fid: number; nonce: number; /** Farcaster time. */ deadline: number; custody: string }

/** The app key port. `@warpstack/wallet/native` implements it over the phone's native module. */
export interface AppKeys {
  /** `next` is a renewal's replacement key, waiting for the vault while the current key keeps working. */
  current(): Promise<{ publicKey: Uint8Array; fid: number | null; pending?: PendingSignIn | undefined; next?: { publicKey: Uint8Array; pending: PendingSignIn } | undefined } | null>
  /** A new key for a sign-in, or, while a key is registered, its replacement for a renewal. */
  create(pending: PendingSignIn): Promise<Uint8Array>
  /** Marks a key registered; a renewal key takes the current key's place. */
  activate(publicKey: Uint8Array, fid: number): Promise<void>
  /** Forgets a key: the current one with any renewal waiting on it, or just the renewal key. */
  clear(publicKey: Uint8Array): Promise<void>
  sign(publicKey: Uint8Array, timestamp: number, body: MessageBody): Promise<Result<Uint8Array, string>>
  signKeyAdd(fid: number, timestamp: number, body: KeyAddBody): Promise<Result<Uint8Array, string>>
  signSelfRevoke(publicKey: Uint8Array, timestamp: number, nonce: number, deadline: number): Promise<Result<Uint8Array, string>>
  signCustodyRemove(publicKey: Uint8Array, timestamp: number, removal: { key: Uint8Array; signature: Uint8Array; nonce: number; deadline: number }): Promise<Result<Uint8Array, string>>
  /** The registered key's signature over a session challenge; native code builds the bytes. */
  signSession(publicKey: Uint8Array, origin: string, nonce: Uint8Array): Promise<Result<Uint8Array, string>>
}

/**
 * The phone's vault: it approves from its own native sheet, where the person types the phrase.
 * It approves only the key store's own pending key. `null` means the person cancelled.
 */
export interface DeviceVault {
  approveKeyAdd(): Promise<Result<{ custodySignature: Uint8Array; metadata: Uint8Array } | null, string>>
  approveKeyRemove(r: { key: Uint8Array; custody: Uint8Array; nonce: number; deadline: number }): Promise<Result<{ signature: Uint8Array } | null, string>>
}

/** A session as the device keeps it: for one deployment, FID and key. */
export type StoredSession = { origin: string; fid: number; key: string; token: string; expiresAt: number }

/**
 * Where the session token survives a relaunch: the Keychain on the phone, through
 * `expo-secure-store`. Without one, each launch opens a new session silently.
 */
export interface SessionStore {
  load(): Promise<StoredSession | null>
  save(s: StoredSession | null): Promise<void>
}

export type AccountState =
  | { kind: 'loading' }
  /** This build can't sign in: a browser, or a phone build without the native vault. */
  | { kind: 'unsupported' }
  /** `notice` says why, when the app signed the person out itself (an expired or revoked key). */
  | { kind: 'signedOut'; notice?: string }
  /** A key is made and waiting for the vault's approval. */
  | { kind: 'linking'; fid: number; fingerprint: string; expiresAt: number }
  /**
   * `expiresAt` is the key's expiry as the node reports it (Unix seconds; it slides forward with
   * each signed message). `renewDue` once it is within `RENEW_WINDOW`: the app asks to renew.
   */
  | { kind: 'signedIn'; fid: number; publicKey: Uint8Array; fingerprint: string; expiresAt?: number; renewDue?: boolean }

/** A revocation of another key, waiting for the vault. */
export type Revocation = { key: string; fingerprint: string; nonce: number; deadline: number; custody: string }

const CANCELLED = warpError('cancelled', 'Cancelled.')

const UNCONFIRMED_WRITE = warpError('unconfirmed', 'Sent, but the network hasn\'t confirmed it yet. It may still go through: check before trying again.')

const PHRASE_WARNING = warpError('phrase', 'That looks like a recovery phrase. It was not sent or saved. Never paste your phrase into an app\'s text box: it belongs only in the vault\'s own secure screen.')

const REQUEST_SECONDS = 15 * 60
const CONFIRM_TRIES = 12
const CONFIRM_DELAY_MS = 1_500
/**
 * How many more reads, and how far apart, before a key the node stopped listing counts as gone:
 * about 20 seconds. Forgetting a key that is still registered loses it, so one node's blip or
 * lag mustn't do it.
 */
const GONE_CHECKS = 4
const GONE_DELAY_MS = 5_000
/** How long a write waits for ingestion to see it merge: about 30 seconds. */
const WRITE_CONFIRM_TRIES = 15
const WRITE_CONFIRM_DELAY_MS = 2_000

const invalid = (message: string) => warpError('invalid', message)

/**
 * A failure as a `WarpError`. The native vault's refusals ("Set a passcode first") are errors
 * with a message meant for the person, coded `ERR_…` by Expo or not at all, and keep it;
 * a failed fetch is a `TypeError` and reads as a network error.
 */
const failure = (e: unknown): WarpError => {
  const code = codeOf(e)
  const native = e instanceof Error && !(e instanceof TypeError) && !(e instanceof ContractError) && !(e instanceof InputError)
    && (code === '' || code.startsWith('ERR_'))
  return native ? invalid(e.message) : toWarpError(e)
}

export type AccountOptions = {
  api: Api
  keys: AppKeys | null
  vault: DeviceVault | null
  /** The deployment's origin, which the key signs session challenges for. Never one a server names. */
  origin: string
  sessions?: SessionStore | null
  /** Unix seconds. */
  now: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Ask to renew the app key this long before it expires. */
export const RENEW_WINDOW_SECONDS = 3 * 86_400

const KEY_GONE = 'This phone\'s key expired or was revoked, so you were signed out. Sign in again to post.'

/** Renew a session this long before it expires. */
const RENEW_MARGIN_SECONDS = 10 * 60
/** A key nobody holds: `signer.registration` before this phone has made its key reads only custody and nonces. */
const NO_KEY = `0x${'00'.repeat(32)}`

export class AccountController {
  private state: AccountState = { kind: 'loading' }
  private session: { token: string; expiresAt: number; fid: number; key: string } | null = null
  private renewing: Promise<string | null> | null = null
  private loading: Promise<void> | null = null
  private pending: (PendingSignIn & { key: Uint8Array }) | null = null
  private readonly listeners = new Set<() => void>()
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly o: AccountOptions) {
    this.sleep = o.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  }

  get current(): AccountState { return this.state }

  subscribe(l: () => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private set(s: AccountState) {
    this.state = s
    if (s.kind !== 'signedIn') {
      if (this.session) void this.o.sessions?.save(null).catch(() => {})
      this.session = null
    } else if (!this.session || this.session.fid !== s.fid || this.session.key !== toHex(s.publicKey)) {
      this.session = null
      void this.renewSession()
    }
    for (const l of this.listeners) l()
  }

  /** A saved session for this deployment, FID and key, if it isn't about to expire. */
  private async restoreSession(fid: number, publicKey: Uint8Array) {
    try {
      const s = await this.o.sessions?.load()
      if (s && s.origin === this.o.origin && s.fid === fid && s.key === toHex(publicKey) && s.expiresAt - this.o.now() > RENEW_MARGIN_SECONDS) {
        this.session = { token: s.token, expiresAt: s.expiresAt, fid: s.fid, key: s.key }
      }
    } catch {
      // An unreadable store means a new session, opened silently.
    }
  }

  /** The session token, if one is open and not about to expire. The API client sends it only on session routes. */
  token(): string | null {
    const s = this.session
    return s && this.state.kind === 'signedIn' && s.fid === this.state.fid && s.key === toHex(this.state.publicKey)
      && s.expiresAt - this.o.now() > RENEW_MARGIN_SECONDS ? s.token : null
  }

  /**
   * Opens a new session: a challenge from the server, the key's signature over it for this
   * deployment's own origin, and the token in exchange. No prompt: the app key signs. Concurrent
   * callers share one attempt. `null` if there's no signed-in key or the server refused.
   */
  renewSession(): Promise<string | null> {
    this.renewing ??= this.openSession().finally(() => { this.renewing = null })
    return this.renewing
  }

  private async openSession(): Promise<string | null> {
    const s = this.state
    if (s.kind !== 'signedIn' || !this.o.keys) return null
    try {
      const key = toHex(s.publicKey)
      const c = await this.o.api.session.challenge({ fid: s.fid as never, key })
      const nonce = fromHex(c.nonce, 32)
      if (!nonce) return null
      const sig = await this.o.keys.signSession(s.publicKey, this.o.origin, nonce)
      if (!sig.ok) return null
      const v = await this.o.api.session.verify({ fid: s.fid as never, key, challenge: c.challenge, signature: toHex(sig.value) })
      const now = this.state
      if (now.kind !== 'signedIn' || now.fid !== s.fid || !equalBytes(now.publicKey, s.publicKey)) return null
      this.session = { token: v.token, expiresAt: v.expiresAt, fid: s.fid, key }
      await this.o.sessions?.save({ origin: this.o.origin, ...this.session }).catch(() => {})
      return v.token
    } catch {
      return null
    }
  }

  /** Custody, nonces and one key's state, fresh from the node. */
  private registration(fid: number, key: string = NO_KEY): Promise<SignerRegistration> {
    return this.o.api.signer.registration({ fid: fid as never, key })
  }

  private fcNow() { return toFarcasterTime(this.o.now() as Timestamp) }

  private linking(p: PendingSignIn & { key: Uint8Array }): AccountState {
    return { kind: 'linking', fid: p.fid, fingerprint: keyFingerprint(p.key), expiresAt: this.o.now() + (p.deadline - this.fcNow()) }
  }

  /**
   * Reads what this phone holds. A pending sign-in completes if the node already lists its
   * key (the page reloaded after submitting), resumes if its request hasn't expired, and is
   * discarded otherwise. So does a renewal, except that one not yet listed is discarded: the
   * current key still works, and renewing again starts over. Concurrent callers share one read.
   */
  load(): Promise<void> {
    this.loading ??= this.read().finally(() => { this.loading = null })
    return this.loading
  }

  /** Resolves once the account is known: the first load, if it hasn't run yet. Requests wait on it to know whether they carry a token. */
  ready(): Promise<void> {
    return this.state.kind === 'loading' ? this.load() : Promise.resolve()
  }

  private async read(): Promise<void> {
    if (!this.o.keys || !this.o.vault) return this.set({ kind: 'unsupported' })
    try {
      const k = await this.o.keys.current()
      if (k && k.fid !== null) {
        this.pending = null
        let key = k.publicKey
        if (k.next) {
          if (k.next.pending.fid === k.fid && await this.confirmKey(k.fid, k.next.publicKey, true, 1)) {
            await this.o.keys.activate(k.next.publicKey, k.fid)
            key = k.next.publicKey
          } else {
            await this.o.keys.clear(k.next.publicKey).catch(() => {})
          }
        }
        await this.restoreSession(k.fid, key)
        this.set({ kind: 'signedIn', fid: k.fid, publicKey: key, fingerprint: keyFingerprint(key) })
        return void this.checkKey()
      }
      if (k?.pending) {
        const p = { ...k.pending, key: k.publicKey }
        if (await this.confirmKey(p.fid, p.key, true, 1)) {
          await this.o.keys.activate(p.key, p.fid)
          this.pending = null
          return this.set({ kind: 'signedIn', fid: p.fid, publicKey: p.key, fingerprint: keyFingerprint(p.key) })
        }
        if (p.deadline > this.fcNow()) {
          this.pending = p
          return this.set(this.linking(p))
        }
      }
      if (k) await this.o.keys.clear(k.publicKey)
      this.pending = null
      this.set({ kind: 'signedOut' })
    } catch {
      // The Keychain is unavailable (the phone is locked, or no passcode): stay read-only.
      this.set({ kind: 'unsupported' })
    }
  }

  /**
   * Reads this phone's key from the node, at launch and when the app comes back to the
   * foreground. A key the node no longer lists (expired, or revoked elsewhere) signs the phone
   * out with a notice; one within `RENEW_WINDOW` of expiry is marked for renewal. A failed
   * read changes nothing, and "gone" counts only once every read over about 20 seconds says so.
   */
  async checkKey(): Promise<void> {
    const s = this.state
    if (s.kind !== 'signedIn' || !this.o.keys) return
    const key = toHex(s.publicKey)
    const read = async () => {
      try {
        return await this.registration(s.fid, key)
      } catch {
        return null
      }
    }
    let r = await read()
    for (let i = 0; i < GONE_CHECKS && r && r.key.state !== 'active'; i++) {
      await this.sleep(GONE_DELAY_MS)
      // A read that fails part way leaves the key alone.
      r = await read()
    }
    const now = this.state
    if (!r || now.kind !== 'signedIn' || now.fid !== s.fid || !equalBytes(now.publicKey, s.publicKey)) return
    if (r.key.state !== 'active') {
      await this.o.keys.clear(s.publicKey).catch(() => {})
      return this.set({ kind: 'signedOut', notice: KEY_GONE })
    }
    const expiresAt = r.key.expiresAt
    const renewDue = expiresAt !== undefined && expiresAt - this.o.now() <= RENEW_WINDOW_SECONDS
    if (expiresAt !== now.expiresAt || renewDue !== !!now.renewDue) this.set({ ...now, expiresAt, renewDue })
  }

  /**
   * Replaces a key that is expiring: the phone makes its replacement, the vault approves it in
   * its sheet as at sign-in, and the new key takes the old one's place once the node lists it.
   * The old key keeps posting until then, so cancelling or failing leaves the account as it
   * was; the phone then forgets the old key, which expires on its own.
   */
  async renew(): Promise<Result<void, WarpError>> {
    const s = this.state
    if (s.kind !== 'signedIn') return err(invalid('Sign in first.'))
    const made = await this.makeKey(s.fid)
    if (!made.ok) return made
    const r = await this.approveSignIn()
    // An unconfirmed key may still merge; a relaunch finishes it if the node lists it.
    if (!r.ok && r.error.kind !== 'unconfirmed') {
      await this.o.keys?.clear(made.value.key).catch(() => {})
      if (this.pending === made.value) this.pending = null
    }
    return r
  }

  /** Makes a new app key for the vault to approve. */
  async startSignIn(fid: number): Promise<Result<void, WarpError>> {
    if (this.state.kind === 'signedIn') return err(invalid('Sign out first.'))
    const made = await this.makeKey(fid)
    if (!made.ok) return made
    this.set(this.linking(made.value))
    return ok(undefined)
  }

  /** A fresh key for the account's next custody nonce, kept as the pending sign-in; one already pending is replaced. */
  private async makeKey(fid: number): Promise<Result<PendingSignIn & { key: Uint8Array }, WarpError>> {
    if (!this.o.keys || !this.o.vault) return err(invalid('Sign in with the Warpstack phone app.'))
    let account: SignerRegistration
    try {
      account = await this.registration(fid)
    } catch (e) {
      return err(codeOf(e) === 'NOT_FOUND' ? invalid(`FID ${fid} doesn't exist.`) : failure(e))
    }
    if (!fromHex(account.custody, 20)) return err(invalid('The node returned a bad custody address.'))
    if (this.pending) await this.o.keys.clear(this.pending.key).catch(() => {})
    this.pending = null
    const pending: PendingSignIn = { fid, nonce: account.nonce + 1, deadline: this.fcNow() + REQUEST_SECONDS, custody: account.custody }
    try {
      this.pending = { ...pending, key: await this.o.keys.create(pending) }
    } catch (e) {
      return err(failure(e))
    }
    return ok(this.pending)
  }

  /** Abandons a sign-in. During a renewal it drops only the replacement: the account stays signed in. */
  async cancelSignIn(): Promise<void> {
    if (this.pending) await this.o.keys?.clear(this.pending.key).catch(() => {})
    this.pending = null
    if (this.state.kind !== 'signedIn') this.set({ kind: 'signedOut' })
  }

  /** Asks the vault to approve the pending key, through its native sheet. */
  async approveSignIn(): Promise<Result<void, WarpError>> {
    const p = this.pending
    if (!p || !this.o.keys || !this.o.vault) return err(invalid('Start sign-in again.'))
    if (p.deadline <= this.fcNow()) return err(warpError('expired', 'The request expired. Start again.'))
    const a = await this.o.vault.approveKeyAdd()
    if (!a.ok) return err(invalid(a.error))
    if (!a.value) return err(CANCELLED)
    return this.completeSignIn(p, a.value)
  }

  /** The key signs its own `KEY_ADD` with the vault's approval; done once the node lists the key. */
  private async completeSignIn(p: PendingSignIn & { key: Uint8Array }, v: { custodySignature: Uint8Array; metadata: Uint8Array }): Promise<Result<void, WarpError>> {
    if (!this.o.keys) return err(invalid('Start sign-in again.'))
    if (p.deadline <= this.fcNow()) return err(warpError('expired', 'The request expired. Start again.'))
    const body: KeyAddBody = { key: p.key, custodySignature: v.custodySignature, deadline: p.deadline, nonce: p.nonce, metadata: v.metadata, scopes: [...POSTING_SCOPES], ttl: APP_KEY_TTL_SECONDS }
    try {
      const signed = await this.o.keys.signKeyAdd(p.fid, this.fcNow(), body)
      if (!signed.ok) return err(invalid(signed.error))
      try {
        await this.o.api.messages.submit({ message: toBase64Url(signed.value) })
      } catch (e) {
        // Approving again after a slow confirmation resubmits a key the node already has;
        // that's success, not a refusal.
        const f = failure(e)
        if (f.kind !== 'rejected' || !(await this.confirmKey(p.fid, p.key, true, 1))) return err(f)
      }
      if (!(await this.confirmKey(p.fid, p.key, true))) {
        return err(warpError('unconfirmed', 'The node took the key but hasn\'t listed it yet. Wait a moment and reopen the app.'))
      }
      await this.o.keys.activate(p.key, p.fid)
    } catch (e) {
      return err(failure(e))
    }
    this.pending = null
    this.set({ kind: 'signedIn', fid: p.fid, publicKey: p.key, fingerprint: keyFingerprint(p.key) })
    return ok(undefined)
  }

  /** Polls the node's signer list until the key is (or is no longer) listed. */
  private async confirmKey(fid: number, key: Uint8Array, present: boolean, tries = CONFIRM_TRIES): Promise<boolean> {
    const hex = toHex(key)
    for (let i = 0; i < tries; i++) {
      try {
        const a = await this.registration(fid, hex)
        if ((a.key.state === 'active') === present) return true
      } catch {
        // Retry: the node or the server may be briefly unavailable.
      }
      if (i < tries - 1) await this.sleep(CONFIRM_DELAY_MS)
    }
    return false
  }

  /**
   * Whether ingestion has seen one of the account's own messages merge. A node's 200 means
   * only "validated and relayed", so a write is done when this says so.
   */
  private async confirmWrite(hash: string): Promise<boolean> {
    for (let i = 0; i < WRITE_CONFIRM_TRIES; i++) {
      try {
        const r = await this.o.api.messages.status({ hashes: hash })
        if ((r.states as Record<string, string>)[hash] === 'merged') return true
      } catch {
        // Retry: the server or the node may be briefly unavailable.
      }
      if (i < WRITE_CONFIRM_TRIES - 1) await this.sleep(WRITE_CONFIRM_DELAY_MS)
    }
    return false
  }

  /**
   * Signs and submits one posting message as the signed-in account, and returns its hash once
   * the network has merged it. `unconfirmed` means it was sent but not seen merging in time.
   */
  async write(body: MessageBody): Promise<Result<string, WarpError>> {
    const s = this.state
    if (s.kind !== 'signedIn' || !this.o.keys) return err(invalid('Sign in to post.'))
    if ((body.type === 'castAdd' && looksLikePhrase(body.text)) || (body.type === 'userDataAdd' && looksLikePhrase(body.value))) return err(PHRASE_WARNING)
    try {
      const signed = await this.o.keys.sign(s.publicKey, this.fcNow(), body)
      if (!signed.ok) {
        // The stored key changed under us: reread it.
        void this.load()
        return err(invalid(signed.error))
      }
      const { hash } = await this.o.api.messages.submit({ message: toBase64Url(signed.value) })
      return (await this.confirmWrite(hash)) ? ok(hash) : err(UNCONFIRMED_WRITE)
    } catch (e) {
      return err(failure(e))
    }
  }

  /**
   * Revokes this phone's key with its own signature, waits for the node to drop it, then
   * forgets it. The key is forgotten even if revoking fails; it then expires 30 days after its
   * last use, and the result says so.
   */
  async signOut(): Promise<Result<void, WarpError>> {
    const s = this.state
    if (s.kind !== 'signedIn' || !this.o.keys) return ok(undefined)
    let problem: WarpError | null = null
    try {
      const account = await this.registration(s.fid, toHex(s.publicKey))
      const signed = await this.o.keys.signSelfRevoke(s.publicKey, this.fcNow(), account.appNonce + 1, this.fcNow() + 10 * 60)
      if (!signed.ok) problem = invalid(signed.error)
      else {
        await this.o.api.messages.submit({ message: toBase64Url(signed.value) })
        if (!(await this.confirmKey(s.fid, s.publicKey, false))) problem = warpError('unconfirmed', 'the node hasn\'t confirmed the revocation')
      }
    } catch (e) {
      problem = failure(e)
    }
    // The revocation is a KEY_REMOVE, which needs the session, so the session ends after it.
    await this.o.api.session.end({}).catch(() => {})
    await this.o.keys.clear(s.publicKey).catch(() => {})
    this.set({ kind: 'signedOut' })
    return problem
      ? err({ ...problem, message: `Signed out here, but the key may still be active (${problem.message}). It expires 30 days after its last use; to be sure, revoke it in Settings from another signed-in device.` })
      : ok(undefined)
  }

  /** Prepares the vault's removal of another key: the next nonce and a deadline. */
  async startRevoke(keyHex: string): Promise<Result<Revocation, WarpError>> {
    const s = this.state
    if (s.kind !== 'signedIn') return err(invalid('Sign in first.'))
    const key = fromHex(keyHex, 32)
    if (!key) return err(invalid('Bad key.'))
    if (equalBytes(key, s.publicKey)) return err(invalid('Sign out to revoke this device\'s own key.'))
    try {
      const account = await this.registration(s.fid, keyHex)
      if (!fromHex(account.custody, 20)) return err(invalid('The node returned a bad custody address.'))
      return ok({ key: keyHex, nonce: account.nonce + 1, deadline: this.fcNow() + REQUEST_SECONDS, custody: account.custody, fingerprint: keyFingerprint(key) })
    } catch (e) {
      return err(failure(e))
    }
  }

  /**
   * Asks the vault to sign the removal, through its native sheet, submits it, and reports
   * success only once the node no longer lists the key.
   */
  async approveRevoke(r: Revocation): Promise<Result<void, WarpError>> {
    const key = fromHex(r.key, 32)
    const custody = fromHex(r.custody, 20)
    if (!this.o.vault || !key || !custody) return err(invalid('Start again.'))
    if (r.deadline <= this.fcNow()) return err(warpError('expired', 'The request expired. Start again.'))
    const a = await this.o.vault.approveKeyRemove({ key, custody, nonce: r.nonce, deadline: r.deadline })
    if (!a.ok) return err(invalid(a.error))
    if (!a.value) return err(CANCELLED)
    return this.completeRevoke(r, a.value.signature)
  }

  private async completeRevoke(r: Revocation, signature: Uint8Array): Promise<Result<void, WarpError>> {
    const s = this.state
    const key = fromHex(r.key, 32)
    if (s.kind !== 'signedIn' || !this.o.keys || !key) return err(invalid('Sign in first.'))
    if (r.deadline <= this.fcNow()) return err(warpError('expired', 'The request expired. Start again.'))
    try {
      const signed = await this.o.keys.signCustodyRemove(s.publicKey, this.fcNow(), { key, signature, nonce: r.nonce, deadline: r.deadline })
      if (!signed.ok) return err(invalid(signed.error))
      await this.o.api.messages.submit({ message: toBase64Url(signed.value) })
    } catch (e) {
      return err(failure(e))
    }
    if (!(await this.confirmKey(s.fid, key, false))) {
      return err(warpError('unconfirmed', 'The node took the revocation but still lists the key. Treat it as live: check again in a minute, and revoke again if it\'s still listed.'))
    }
    return ok(undefined)
  }
}
