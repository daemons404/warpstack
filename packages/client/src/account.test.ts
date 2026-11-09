import { ed25519 } from '@noble/curves/ed25519.js'
import * as fc from '@farcaster/core'
import {
  APP_KEY_TTL_SECONDS, encodeSignedKeyRequestMetadata, fromBase64Url, fromHex, keyFingerprint, messageHash, POSTING_SCOPES, readFields,
  sessionPreimage, toFarcasterTime, toHex, verifyMessage, verifySession, type Timestamp, type VerifiedMessage,
} from '@warpstack/protocol'
import { NativeAppKeyStore, type PendingSignIn, type WarpstackVaultModule } from '@warpstack/wallet/native'
import { mnemonicToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
import { AccountController, type SessionStore, type StoredSession } from './account.ts'
import type { Api } from './api.ts'

const PHRASE = 'test test test test test test test test test test test junk'
const CUSTODY = mnemonicToAccount(PHRASE).address.toLowerCase()
const NOW = 1_793_000_000
const FID = 1234
const ORIGIN = 'https://warpstack.test'

/** A KEY_REMOVE's target key, signature type and nonce. */
const removal = (m: VerifiedMessage) => {
  const body = readFields(m.dataBytes).find(f => f.field === 20)
  const fields = body?.wire === 2 ? readFields(body.value) : []
  const get = (n: number) => fields.find(f => f.field === n)
  const key = get(1)
  return { key: key?.wire === 2 ? toHex(key.value) : null, signatureType: get(3)?.value, nonce: get(5)?.value }
}

/**
 * A server that verifies submissions and sessions, and models the node: a KEY_ADD lists its
 * key, a KEY_REMOVE drops the key it targets. `merge: false` admits messages without merging
 * them. Every message but a KEY_ADD needs a session opened with a valid signature from a key
 * the node lists, over this deployment's origin; the API client attaches the token itself, so
 * here a session is open once `session.verify` has succeeded and until `session.end`.
 */
const fakeServer = (o: { merge?: boolean } = {}) => {
  const submitted: VerifiedMessage[] = []
  const keys = new Set<string>()
  const sessions = { opened: 0, ended: 0, open: false }
  const merged = new Set<string>()
  /** Each key's expiry as the node reports it, when set. */
  const expiries = new Map<string, number>()
  let nonce = 0
  let userNonce = 4
  let appNonce = 0
  const unauthorized = (reason: string) => Object.assign(new Error(reason), { code: 'UNAUTHORIZED', data: { reason } })
  const api = {
    signer: {
      registration: async ({ fid, key }: { fid: number; key: string }) => {
        if (fid !== FID) throw Object.assign(new Error('nf'), { code: 'NOT_FOUND' })
        const expiresAt = expiries.get(key)
        return { custody: CUSTODY, nonce: userNonce, appNonce, key: keys.has(key) ? { state: 'active', ...(expiresAt ? { expiresAt } : {}) } : { state: 'absent' } }
      },
    },
    session: {
      challenge: async () => ({ challenge: `c${++nonce}`, nonce: toHex(new Uint8Array(32).fill(nonce)), expiresAt: NOW + 300 }),
      verify: async (v: { fid: number; key: string; challenge: string; signature: string }) => {
        const n = new Uint8Array(32).fill(Number(v.challenge.slice(1)))
        if (!verifySession(fromHex(v.key, 32)!, ORIGIN, n, fromHex(v.signature, 64)!)) throw unauthorized('signature')
        if (!keys.has(v.key)) throw unauthorized('keyInactive')
        sessions.opened++
        sessions.open = true
        return { token: `token-${sessions.opened}`, expiresAt: NOW + 86_400 }
      },
      end: async () => {
        if (!sessions.open) throw unauthorized('session')
        sessions.ended++
        sessions.open = false
        return { ok: true }
      },
    },
    messages: {
      // Merged when the node merged it; a message the node only admitted stays unknown.
      status: async ({ hashes }: { hashes: string }) => ({
        states: Object.fromEntries(hashes.split(',').map(h => [h, merged.has(h) ? 'merged' : 'unknown'])),
      }),
      submit: async ({ message }: { message: string }) => {
        const v = verifyMessage(fromBase64Url(message)!)
        if (!v.ok) throw Object.assign(new Error('rejected'), { code: 'REJECTED', data: { reason: v.error } })
        if (v.value.type !== 16 && !sessions.open) throw unauthorized('session')
        submitted.push(v.value)
        if (o.merge !== false) {
          merged.add(v.value.hash)
          if (v.value.type === 16) { keys.add(toHex(v.value.signer)); userNonce++ }
          if (v.value.type === 17) {
            const r = removal(v.value)
            keys.delete(r.key!)
            if (r.signatureType === 2) appNonce++
            else userNonce++
          }
        }
        return { hash: v.value.hash }
      },
    },
  } as unknown as Api
  return { api, submitted, keys, sessions, expiries }
}

type Record = { seed: Uint8Array; publicKey: Uint8Array; fid: number | null; pending: PendingSignIn | undefined }
/** The two Keychain items: the account's key, and a renewal's replacement waiting on it. */
type Slot = { rec: Record | null; next?: Record | null }

/**
 * The native module as the Swift layer behaves, in memory: the seed never leaves it, signing
 * follows the stored FID, and the vault signs only for the stored pending key, with the
 * account the phrase the person types (here, the development phrase) holds. Custody signatures
 * come from viem over @farcaster/core's types, an implementation independent of ours.
 * `slot` holds the Keychain items, so two controllers sharing it model a relaunch.
 */
const fakeNative = (slot: Slot = { rec: null }, o: { cancel?: boolean } = {}) => {
  const custodyAccount = mnemonicToAccount(PHRASE)
  const sheet = () => {
    if (o.cancel) throw Object.assign(new Error('Cancelled.'), { code: 'ERR_CANCELLED' })
  }
  /** The renewal key, if the current key is registered and one waits for its FID. */
  const renewal = () => (slot.rec?.fid && slot.next?.pending?.fid === slot.rec.fid ? slot.next : null)
  const native: WarpstackVaultModule = {
    current: async () => {
      const r = slot.rec
      const n = renewal()
      return r && {
        publicKey: toHex(r.publicKey), fid: r.fid, ...(r.pending ? { pending: r.pending } : {}),
        ...(n?.pending ? { next: { publicKey: toHex(n.publicKey), pending: n.pending } } : {}),
      }
    },
    create: async (fid, nonce, deadline, custody) => {
      if (slot.rec?.fid && slot.rec.fid !== fid) throw new Error('signed in as another FID')
      const seed = ed25519.utils.randomSecretKey()
      const rec = { seed, publicKey: ed25519.getPublicKey(seed), fid: null, pending: { fid, nonce, deadline, custody } }
      if (slot.rec?.fid) slot.next = rec
      else { slot.rec = rec; slot.next = null }
      return toHex(rec.publicKey)
    },
    activate: async (publicKey, fid) => {
      const r = slot.rec
      const n = renewal()
      if (r && toHex(r.publicKey) === publicKey && r.fid === null && r.pending?.fid === fid) slot.rec = { ...r, fid, pending: undefined }
      else if (n && toHex(n.publicKey) === publicKey && r?.fid === fid) { slot.rec = { ...n, fid, pending: undefined }; slot.next = null }
      else throw new Error('changed')
    },
    clear: async publicKey => {
      if (slot.rec && toHex(slot.rec.publicKey) === publicKey) { slot.rec = null; slot.next = null }
      else if (slot.next && toHex(slot.next.publicKey) === publicKey) slot.next = null
    },
    signSession: async (publicKey, origin, nonce) => {
      const r = slot.rec
      if (!r || toHex(r.publicKey) !== publicKey || r.fid === null) throw new Error('refused')
      const pre = sessionPreimage(origin, fromHex(nonce, 32)!)
      if (!pre.ok) throw new Error(pre.error)
      return toHex(ed25519.sign(pre.value, r.seed))
    },
    sign: async (publicKey, purpose, data) => {
      const n = renewal()
      const r = purpose === 'ownKeyAdd' && n && toHex(n.publicKey) === publicKey ? n : slot.rec
      if (!r || toHex(r.publicKey) !== publicKey || (purpose === 'ownKeyAdd') !== (r.fid === null)) throw new Error('refused')
      const hash = messageHash(fromHex(data)!)
      return { hash: toHex(hash), signature: toHex(ed25519.sign(hash, r.seed)) }
    },
    approveKeyAdd: async () => {
      const r = slot.rec?.fid === null ? slot.rec : renewal()
      const p = r?.pending
      if (!r || !p) throw new Error('no sign-in waiting')
      sheet()
      const key = toHex(r.publicKey)
      const requestSig = await custodyAccount.signTypedData({
        ...fc.GASLESS_SIGNED_KEY_REQUEST_EIP_712_TYPES, primaryType: 'SignedKeyRequest', message: { requestFid: BigInt(p.fid), key, deadline: BigInt(p.deadline) },
      })
      const metadata = encodeSignedKeyRequestMetadata({ requestFid: p.fid, requestSigner: fromHex(p.custody, 20)!, signature: fromHex(requestSig, 65)!, deadline: p.deadline })
      const custodySignature = await custodyAccount.signTypedData({
        ...fc.GASLESS_KEY_ADD_EIP_712_TYPES, primaryType: 'KeyAdd',
        message: { fid: BigInt(p.fid), key, keyType: 1, scopes: [...POSTING_SCOPES], ttl: APP_KEY_TTL_SECONDS, nonce: p.nonce, deadline: BigInt(p.deadline) },
      })
      return { custodySignature, metadata: toHex(metadata), scopes: [...POSTING_SCOPES], ttl: APP_KEY_TTL_SECONDS }
    },
    approveKeyRemove: async (key, _custody, nonce, deadline) => {
      if (!slot.rec?.fid) throw new Error('sign in first')
      sheet()
      const signature = await custodyAccount.signTypedData({
        ...fc.GASLESS_KEY_REMOVE_EIP_712_TYPES, primaryType: 'KeyRemove', message: { fid: BigInt(slot.rec.fid), key: key as `0x${string}`, nonce, deadline: BigInt(deadline) },
      })
      return { signature }
    },
  }
  return native
}

/** The Keychain item the session token lives in, shared across relaunches like `slot`. */
const memorySessions = (box: { s: StoredSession | null } = { s: null }): SessionStore & { box: typeof box } => ({
  box,
  load: async () => box.s,
  save: async s => { box.s = s },
})

const setup = (o: { merge?: boolean; server?: ReturnType<typeof fakeServer>; slot?: Slot; cancel?: boolean; sessions?: SessionStore } = {}) => {
  const server = o.server ?? fakeServer(o)
  const slot = o.slot ?? { rec: null }
  const store = new NativeAppKeyStore(fakeNative(slot, o))
  const account = new AccountController({ api: server.api, keys: store, vault: store, origin: ORIGIN, sessions: o.sessions ?? null, now: () => NOW, sleep: async () => {} })
  return { server, store, account, slot }
}

const signIn = async (account: AccountController) => {
  await account.load()
  expect((await account.startSignIn(FID)).ok).toBe(true)
  const r = await account.approveSignIn()
  if (!r.ok) throw new Error(r.error.message)
  const after = account.current
  if (after.kind !== 'signedIn') throw new Error(after.kind)
  return after
}

describe('sign-in through the phone\'s vault', () => {
  it('makes a key for the account\'s next nonce, approves it in the native sheet, then posts', async () => {
    const { server, account, slot } = setup()
    await account.load()
    expect(account.current.kind).toBe('signedOut')
    await account.startSignIn(FID)
    expect(account.current).toMatchObject({ kind: 'linking', fid: FID })
    expect(slot.rec?.pending).toMatchObject({ fid: FID, nonce: 5, custody: CUSTODY })
    expect(await account.approveSignIn()).toEqual({ ok: true, value: undefined })
    expect(account.current.kind).toBe('signedIn')
    expect(server.submitted.at(-1)?.type).toBe(16)
    // The key opens a session for this deployment's origin, with no prompt.
    expect(await account.renewSession()).toBe('token-1')
    expect(account.token()).toBe('token-1')
    expect((await account.write({ type: 'castAdd', text: 'gm from the phone' })).ok).toBe(true)
    expect(server.submitted.at(-1)).toMatchObject({ type: 1, fid: FID })
  })

  it('opens one session for concurrent callers, and none for a key the node doesn\'t list', async () => {
    const { server, account } = setup()
    await signIn(account)
    const [a, b] = await Promise.all([account.renewSession(), account.renewSession()])
    expect(a).toBe(b)
    server.keys.clear()
    expect(await account.renewSession()).toBeNull()
  })

  it('stays waiting, with nothing submitted, when the person cancels the sheet', async () => {
    const { server, account } = setup({ cancel: true })
    await account.load()
    await account.startSignIn(FID)
    expect(await account.approveSignIn()).toMatchObject({ ok: false, error: { kind: 'cancelled' } })
    expect(account.current.kind).toBe('linking')
    expect(server.submitted).toHaveLength(0)
  })

  it('keeps the session in the store across a relaunch, and forgets it on sign-out', async () => {
    const server = fakeServer()
    const slot: Slot = { rec: null }
    const sessions = memorySessions()
    const first = setup({ server, slot, sessions })
    await signIn(first.account)
    await first.account.renewSession()
    expect(sessions.box.s).toMatchObject({ origin: ORIGIN, fid: FID, token: 'token-1' })
    // A relaunch reads the stored session instead of opening another.
    const relaunched = setup({ server, slot, sessions })
    await relaunched.account.load()
    expect(relaunched.account.token()).toBe('token-1')
    expect(server.sessions.opened).toBe(1)
    // A session saved for another deployment is never reused.
    const elsewhere = memorySessions({ s: { ...sessions.box.s!, origin: 'https://other.test' } })
    const third = setup({ server, slot, sessions: elsewhere })
    await third.account.load()
    // It opens its own session instead.
    expect(third.account.token()).not.toBe('token-1')
    await relaunched.account.signOut()
    expect(sessions.box.s).toBeNull()
  })

  it('reads the phone once for every screen that asks at launch', async () => {
    const server = fakeServer()
    const slot: Slot = { rec: null }
    await signIn(setup({ server, slot }).account)
    const relaunched = setup({ server, slot })
    let reads = 0
    const current = relaunched.store.current.bind(relaunched.store)
    relaunched.store.current = async () => { reads++; return current() }
    await Promise.all(Array.from({ length: 50 }, () => relaunched.account.load()))
    expect(reads).toBe(1)
    expect(relaunched.account.current.kind).toBe('signedIn')
    // Once known, ready() doesn't read again.
    await relaunched.account.ready()
    expect(reads).toBe(1)
  })

  it('is read-only without the native vault', async () => {
    const server = fakeServer()
    const account = new AccountController({ api: server.api, keys: null, vault: null, origin: ORIGIN, now: () => NOW })
    await account.load()
    expect(account.current.kind).toBe('unsupported')
    expect((await account.startSignIn(FID)).ok).toBe(false)
  })

  it('says so, without signing in, when the node admits the KEY_ADD but never lists it', async () => {
    const { account } = setup({ merge: false })
    await account.load()
    await account.startSignIn(FID)
    expect(await account.approveSignIn()).toMatchObject({ ok: false, error: { kind: 'unconfirmed' } })
    expect(account.current.kind).toBe('linking')
  })

  it('finishes a sign-in after a relaunch once the node lists the key, and resumes one still waiting', async () => {
    const server = fakeServer()
    const slot: Slot = { rec: null }
    const first = setup({ server, slot })
    await first.account.load()
    await first.account.startSignIn(FID)
    // The app relaunches before the approval: the sign-in resumes.
    const relaunched = setup({ server, slot })
    await relaunched.account.load()
    expect(relaunched.account.current).toMatchObject({ kind: 'linking', fid: FID })
    // The KEY_ADD merges but the app is killed before it notices: the next launch completes.
    server.keys.add(toHex(slot.rec!.publicKey))
    const third = setup({ server, slot })
    await third.account.load()
    expect(third.account.current.kind).toBe('signedIn')
  })

  it('discards a pending key whose deadline passed', async () => {
    const slot: Slot = { rec: null }
    const { store } = setup({ slot })
    await store.create({ fid: FID, nonce: 5, deadline: toFarcasterTime(NOW as Timestamp) - 1, custody: CUSTODY })
    const { account } = setup({ slot })
    await account.load()
    expect(account.current.kind).toBe('signedOut')
    expect(slot.rec).toBeNull()
  })

  it('treats a write as done only once the network merged it', async () => {
    const { server, account } = setup()
    await signIn(account)
    expect((await account.write({ type: 'castAdd', text: 'merged' })).ok).toBe(true)
    // The node admits the next cast but never merges it.
    const submit = server.api.messages.submit
    ;(server.api.messages as { submit: unknown }).submit = async (i: { message: string }) => ({ hash: verifyMessage(fromBase64Url(i.message)!).ok ? '0x1' : '0x' })
    expect(await account.write({ type: 'castAdd', text: 'admitted only' })).toMatchObject({ ok: false, error: { kind: 'unconfirmed' } })
    ;(server.api.messages as { submit: unknown }).submit = submit
  })

  it('marks a key near expiry for renewal, and leaves a fresh one alone', async () => {
    const { server, account } = setup()
    const s = await signIn(account)
    server.expiries.set(toHex(s.publicKey), NOW + 20 * 86_400)
    await account.checkKey()
    expect(account.current).toMatchObject({ kind: 'signedIn', renewDue: false, expiresAt: NOW + 20 * 86_400 })
    server.expiries.set(toHex(s.publicKey), NOW + 2 * 86_400)
    await account.checkKey()
    expect(account.current).toMatchObject({ kind: 'signedIn', renewDue: true })
  })

  it('signs out with a reason when the node no longer lists the key', async () => {
    const { server, store, account } = setup()
    const s = await signIn(account)
    server.keys.delete(toHex(s.publicKey))
    await account.checkKey()
    expect(account.current).toMatchObject({ kind: 'signedOut', notice: expect.stringContaining('expired or was revoked') })
    expect(await store.current()).toBeNull()
  })

  it('keeps a key the node drops for a few reads and then lists again', async () => {
    const { server, store, account } = setup()
    const s = await signIn(account)
    const key = toHex(s.publicKey)
    const registration = server.api.signer.registration
    let reads = 0
    // A lagging node misses the key for three reads, then catches up.
    ;(server.api.signer as { registration: unknown }).registration = async (i: { fid: number; key: string }) => {
      const r = await registration(i as never)
      return ++reads <= 3 && i.key === key ? { ...r, key: { state: 'absent' } } : r
    }
    await account.checkKey()
    expect(account.current.kind).toBe('signedIn')
    expect(await store.current()).not.toBeNull()
  })

  it('renews by approving a fresh key in the vault, and keeps posting', async () => {
    const { server, store, account } = setup()
    const old = await signIn(account)
    expect(await account.renew()).toEqual({ ok: true, value: undefined })
    const now = account.current
    if (now.kind !== 'signedIn') throw new Error(now.kind)
    expect(toHex(now.publicKey)).not.toBe(toHex(old.publicKey))
    expect(server.keys.has(toHex(now.publicKey))).toBe(true)
    expect(toHex((await store.current())!.publicKey)).toBe(toHex(now.publicKey))
    expect((await account.write({ type: 'castAdd', text: 'after renewal' })).ok).toBe(true)
    expect(await store.current()).toMatchObject({ next: undefined })
  })

  it('keeps the old key signed in and posting when a renewal is cancelled', async () => {
    const o = { cancel: false }
    const { server, store, account, slot } = setup(o)
    const old = await signIn(account)
    o.cancel = true
    expect(await account.renew()).toMatchObject({ ok: false, error: { kind: 'cancelled' } })
    expect(account.current).toMatchObject({ kind: 'signedIn', fingerprint: old.fingerprint })
    expect(toHex((await store.current())!.publicKey)).toBe(toHex(old.publicKey))
    expect(slot.next).toBeNull()
    expect(server.keys.size).toBe(1)
    expect((await account.write({ type: 'castAdd', text: 'still here' })).ok).toBe(true)
  })

  it('posts with the old key while a renewal waits on the node, and finishes it after a relaunch', async () => {
    const server = fakeServer({ merge: false })
    const slot: Slot = { rec: null }
    // Signed in on a node that merges, then the node stops merging before the renewal.
    const first = setup({ server: fakeServer(), slot })
    const old = await signIn(first.account)
    server.keys.add(toHex(old.publicKey))
    const { account } = setup({ server, slot })
    await account.load()
    expect(await account.renew()).toMatchObject({ ok: false, error: { kind: 'unconfirmed' } })
    expect(account.current).toMatchObject({ kind: 'signedIn', fingerprint: old.fingerprint })
    expect(slot.next).not.toBeNull()
    // Not yet listed at the next launch: the renewal key is dropped and the old key stays.
    const again = setup({ server, slot })
    await again.account.load()
    expect(again.account.current).toMatchObject({ kind: 'signedIn', fingerprint: old.fingerprint })
    expect(slot.next).toBeNull()
    // Listed at launch: the new key takes the old one's place.
    await again.account.renew()
    const next = slot.next!
    server.keys.add(toHex(next.publicKey))
    const third = setup({ server, slot })
    await third.account.load()
    expect(third.account.current).toMatchObject({ kind: 'signedIn', fingerprint: keyFingerprint(next.publicKey) })
    expect(toHex(slot.rec!.publicKey)).toBe(toHex(next.publicKey))
    expect(slot.next).toBeNull()
  })

  it('won\'t start a second sign-in over a signed-in key', async () => {
    const { account } = setup()
    await signIn(account)
    expect(await account.startSignIn(FID)).toMatchObject({ ok: false })
    expect(account.current.kind).toBe('signedIn')
  })

  it('won\'t sign a cast or bio that contains a phrase', async () => {
    const { server, account } = setup()
    await signIn(account)
    const before = server.submitted.length
    expect((await account.write({ type: 'castAdd', text: `backup: ${PHRASE}` })).ok).toBe(false)
    expect((await account.write({ type: 'userDataAdd', field: 'bio', value: PHRASE })).ok).toBe(false)
    expect(server.submitted).toHaveLength(before)
  })

  it('signs out by self-revoking its own key with the next app nonce, then forgets it', async () => {
    const { server, store, account } = setup()
    const s = await signIn(account)
    await account.renewSession()
    expect((await account.signOut()).ok).toBe(true)
    // The revocation went out with the session, which ended after it.
    expect(server.sessions).toMatchObject({ ended: 1, open: false })
    expect(account.token()).toBeNull()
    const last = server.submitted.at(-1)!
    expect(last.type).toBe(17)
    expect(removal(last)).toEqual({ key: toHex(s.publicKey), signatureType: 2, nonce: 1 })
    expect(await store.current()).toBeNull()
    expect(account.current.kind).toBe('signedOut')
  })

  it('revokes another key in the native sheet, and reports it only once the node drops it', async () => {
    const { server, account } = setup()
    await signIn(account)
    const other = toHex(new Uint8Array(32).fill(8))
    server.keys.add(other)
    const rev = await account.startRevoke(other)
    if (!rev.ok) throw new Error(rev.error.message)
    expect(await account.approveRevoke(rev.value)).toEqual({ ok: true, value: undefined })
    expect(removal(server.submitted.at(-1)!)).toMatchObject({ key: other, signatureType: 1 })
    expect(server.keys.has(other)).toBe(false)
    expect(account.current.kind).toBe('signedIn')
  })

  it('reports a revocation the node didn\'t merge as unconfirmed, not done', async () => {
    const server = fakeServer()
    const { account } = setup({ server })
    await signIn(account)
    const other = toHex(new Uint8Array(32).fill(8))
    server.keys.add(other)
    const rev = await account.startRevoke(other)
    if (!rev.ok) throw new Error()
    // The node admits the removal but never merges it.
    const submit = server.api.messages.submit
    ;(server.api.messages as { submit: unknown }).submit = async (i: { message: string }) => ({ hash: verifyMessage(fromBase64Url(i.message)!).ok ? '0x' : '0x' })
    expect(await account.approveRevoke(rev.value)).toMatchObject({ ok: false, error: { kind: 'unconfirmed' } })
    ;(server.api.messages as { submit: unknown }).submit = submit
  })

  it('won\'t revoke this phone\'s own key through the vault; that\'s sign-out', async () => {
    const { account } = setup()
    const s = await signIn(account)
    expect((await account.startRevoke(toHex(s.publicKey))).ok).toBe(false)
  })
})
