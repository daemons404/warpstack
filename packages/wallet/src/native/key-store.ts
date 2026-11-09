import {
  APP_KEY_TTL_SECONDS, encodeEnvelope, encodeMessageData, equalBytes, err, fromHex, messageHash, ok, parseSessionOrigin, POSTING_SCOPES, toHex, TYPE_OF, verifySession,
  type KeyAddBody, type MessageBody, type MessageDataInput, type Result,
} from '@warpstack/protocol'

// The phone's app key and transient vault (M1.5 on the phone).
// The key's seed lives in the Keychain and is used only by the Rust core behind the
// `WarpstackVault` native module, which this wraps. JavaScript encodes each message; native
// code decodes it again, checks it against the purpose and the FID it stored, and signs the
// exact bytes. The vault's approvals come from a native sheet, where the person types the
// phrase; nothing here ever sees it.

export type PendingSignIn = { fid: number; nonce: number; /** Farcaster time. */ deadline: number; custody: string }

/** The native module's surface, as `WarpstackVaultModule.swift` defines it. */
export interface WarpstackVaultModule {
  /** `next` is a renewal's replacement key, waiting for the vault while the current key keeps working. */
  current(): Promise<{ publicKey: string; fid: number | null; pending?: PendingSignIn; next?: { publicKey: string; pending: PendingSignIn } } | null>
  create(fid: number, nonce: number, deadline: number, custody: string): Promise<string>
  activate(publicKey: string, fid: number): Promise<void>
  clear(publicKey: string): Promise<void>
  sign(publicKey: string, purpose: 'posting' | 'ownKeyAdd' | 'selfRemove' | 'custodyRemove', data: string): Promise<{ hash: string; signature: string }>
  signSession(publicKey: string, origin: string, nonce: string): Promise<string>
  approveKeyAdd(): Promise<{ custodySignature: string; metadata: string; scopes: number[]; ttl: number }>
  approveKeyRemove(key: string, custody: string, nonce: number, deadline: number): Promise<{ signature: string }>
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))
const cancelled = (e: unknown) => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ERR_CANCELLED'

export class NativeAppKeyStore {
  constructor(private readonly native: WarpstackVaultModule) {}

  async current(): Promise<{ publicKey: Uint8Array; fid: number | null; pending?: PendingSignIn | undefined; next?: { publicKey: Uint8Array; pending: PendingSignIn } | undefined } | null> {
    const s = await this.native.current()
    const publicKey = s && fromHex(s.publicKey, 32)
    if (!s || !publicKey) return null
    const nextKey = s.next && fromHex(s.next.publicKey, 32)
    return { publicKey, fid: s.fid, pending: s.pending, next: s.next && nextKey ? { publicKey: nextKey, pending: s.next.pending } : undefined }
  }

  /**
   * A new key for a sign-in, or, while a key is registered, its replacement for a renewal,
   * which waits as `next` and takes the current key's place on `activate`.
   */
  async create(p: PendingSignIn): Promise<Uint8Array> {
    const key = fromHex(await this.native.create(p.fid, p.nonce, p.deadline, p.custody), 32)
    if (!key) throw new Error('The vault returned a bad key.')
    return key
  }

  activate(publicKey: Uint8Array, fid: number): Promise<void> {
    return this.native.activate(toHex(publicKey), fid)
  }

  clear(publicKey: Uint8Array): Promise<void> {
    return this.native.clear(toHex(publicKey))
  }

  private async signData(publicKey: Uint8Array, purpose: Parameters<WarpstackVaultModule['sign']>[1], input: MessageDataInput): Promise<Result<Uint8Array, string>> {
    const data = encodeMessageData(input)
    if (!data.ok) return err(data.error.detail)
    try {
      const s = await this.native.sign(toHex(publicKey), purpose, toHex(data.value))
      const hash = fromHex(s.hash, 20)
      const signature = fromHex(s.signature, 64)
      if (!hash || !signature || !equalBytes(hash, messageHash(data.value))) return err('The app key returned a bad signature.')
      return ok(encodeEnvelope({ dataBytes: data.value, hash, signature, signer: publicKey }))
    } catch (e) {
      return err(messageOf(e))
    }
  }

  /** A posting message for the key's own FID, which native code reads from its own record. */
  async sign(publicKey: Uint8Array, timestamp: number, body: MessageBody): Promise<Result<Uint8Array, string>> {
    if (!POSTING_SCOPES.includes(TYPE_OF[body.type])) return err('An app key signs only posting messages.')
    const s = await this.current()
    if (!s || s.fid === null || !equalBytes(s.publicKey, publicKey)) return err('The key changed. Sign in again.')
    return this.signData(publicKey, 'posting', { fid: s.fid, timestamp, body })
  }

  signKeyAdd(fid: number, timestamp: number, body: KeyAddBody): Promise<Result<Uint8Array, string>> {
    return this.signData(body.key, 'ownKeyAdd', { fid, timestamp, body: { type: 'keyAdd', body } })
  }

  async signSelfRevoke(publicKey: Uint8Array, timestamp: number, nonce: number, deadline: number): Promise<Result<Uint8Array, string>> {
    const s = await this.current()
    if (!s || s.fid === null || !equalBytes(s.publicKey, publicKey)) return err('The key changed. Sign in again.')
    return this.signData(publicKey, 'selfRemove', {
      fid: s.fid, timestamp, body: { type: 'keyRemove', body: { key: publicKey, signature: new Uint8Array(), signatureType: 2, nonce, deadline } },
    })
  }

  async signCustodyRemove(publicKey: Uint8Array, timestamp: number, removal: { key: Uint8Array; signature: Uint8Array; nonce: number; deadline: number }): Promise<Result<Uint8Array, string>> {
    const s = await this.current()
    if (!s || s.fid === null || !equalBytes(s.publicKey, publicKey)) return err('The key changed. Sign in again.')
    if (equalBytes(removal.key, publicKey)) return err('Sign out to revoke this phone\'s own key.')
    return this.signData(publicKey, 'custodyRemove', { fid: s.fid, timestamp, body: { type: 'keyRemove', body: { ...removal, signatureType: 1 } } })
  }

  /**
   * The registered key's signature over a session challenge for `origin`
   * (`signSession`). Native code builds the bytes; this checks the signature before returning it.
   */
  async signSession(publicKey: Uint8Array, origin: string, nonce: Uint8Array): Promise<Result<Uint8Array, string>> {
    if (!parseSessionOrigin(origin).ok || nonce.length !== 32) return err('Bad session challenge.')
    try {
      const signature = fromHex(await this.native.signSession(toHex(publicKey), origin, toHex(nonce)), 64)
      if (!signature || !verifySession(publicKey, origin, nonce, signature)) return err('The app key returned a bad signature.')
      return ok(signature)
    } catch (e) {
      return err(messageOf(e))
    }
  }

  /** The vault's approval of the pending key, from the native sheet. `null` if the person cancelled. */
  async approveKeyAdd(): Promise<Result<{ custodySignature: Uint8Array; metadata: Uint8Array } | null, string>> {
    try {
      const a = await this.native.approveKeyAdd()
      const custodySignature = fromHex(a.custodySignature, 65)
      const metadata = fromHex(a.metadata)
      // The scopes and TTL are constants in Rust; the key add body must carry the same ones.
      if (!custodySignature || !metadata || a.ttl !== APP_KEY_TTL_SECONDS || a.scopes.join() !== POSTING_SCOPES.join()) {
        return err('The vault\'s approval doesn\'t match this app.')
      }
      return ok({ custodySignature, metadata })
    } catch (e) {
      return cancelled(e) ? ok(null) : err(messageOf(e))
    }
  }

  /** The vault's custody removal of another key, from the native sheet. `null` if the person cancelled. */
  async approveKeyRemove(r: { key: Uint8Array; custody: Uint8Array; nonce: number; deadline: number }): Promise<Result<{ signature: Uint8Array } | null, string>> {
    try {
      const a = await this.native.approveKeyRemove(toHex(r.key), toHex(r.custody), r.nonce, r.deadline)
      const signature = fromHex(a.signature, 65)
      return signature ? ok({ signature }) : err('The vault returned a bad signature.')
    } catch (e) {
      return cancelled(e) ? ok(null) : err(messageOf(e))
    }
  }
}
