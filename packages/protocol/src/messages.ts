import { blake3 } from '@noble/hashes/blake3.js'
import { fromHex } from './bytes.ts'
import { err, ok, type Result } from './result.ts'
import { Writer } from './proto.ts'

// Farcaster messages: the message types an app key signs, encoded as
// `MessageData` bytes, hashed with BLAKE3 to 20 bytes, and wrapped in a `Message` envelope
// that carries `data_bytes`, which is what Snapchain hashes and verifies. The builders refuse
// what Snapchain would refuse for size, so a bad draft fails here, before anything is signed.

export const MessageType = {
  CAST_ADD: 1,
  CAST_REMOVE: 2,
  REACTION_ADD: 3,
  REACTION_REMOVE: 4,
  LINK_ADD: 5,
  LINK_REMOVE: 6,
  USER_DATA_ADD: 11,
  KEY_ADD: 16,
  KEY_REMOVE: 17,
} as const
export type MessageType = (typeof MessageType)[keyof typeof MessageType]

export const FARCASTER_MAINNET = 1
const HASH_SCHEME_BLAKE3 = 1
const SIGNATURE_SCHEME_ED25519 = 1

/** Snapchain's byte limits for what M1.5 builds. */
export const MESSAGE_LIMITS = {
  /** `MessageData` bytes for every type here. */
  dataBytes: 2_048,
  /** A standard cast's text, in UTF-8 bytes. */
  castText: 320,
  embeds: 2,
  mentions: 10,
  embedUrl: 256,
  parentUrl: 256,
  /** A user data value, in UTF-8 bytes, by field. */
  userData: { pfp: 256, display: 32, bio: 256, url: 256, location: 50, banner: 256 },
} as const

export const USER_DATA_TYPES = { pfp: 1, display: 2, bio: 3, url: 5, location: 7, banner: 10 } as const
export type UserDataField = keyof typeof USER_DATA_TYPES

export type CastRef = { fid: number; hash: string }
export type Embed = { url: string } | { cast: CastRef }

export type KeyAddBody = {
  key: Uint8Array
  custodySignature: Uint8Array
  /** Farcaster time. */
  deadline: number
  nonce: number
  metadata: Uint8Array
  scopes: readonly number[]
  ttl: number
}

export type KeyRemoveBody = {
  key: Uint8Array
  /** Empty for self-revocation: the envelope's signature is the authorization. */
  signature: Uint8Array
  /** 1 = custody (EIP-712), 2 = self. */
  signatureType: 1 | 2
  deadline: number
  nonce: number
}

export type MessageBody =
  | { type: 'castAdd'; text: string; mentions?: readonly number[]; mentionsPositions?: readonly number[]; embeds?: readonly Embed[]; parent?: CastRef | { url: string } }
  | { type: 'castRemove'; hash: string }
  | { type: 'reactionAdd' | 'reactionRemove'; reaction: 'like' | 'recast'; target: CastRef }
  | { type: 'linkAdd' | 'linkRemove'; targetFid: number }
  | { type: 'userDataAdd'; field: UserDataField; value: string }
  | { type: 'keyAdd'; body: KeyAddBody }
  | { type: 'keyRemove'; body: KeyRemoveBody }

export const TYPE_OF: Record<MessageBody['type'], MessageType> = {
  castAdd: MessageType.CAST_ADD,
  castRemove: MessageType.CAST_REMOVE,
  reactionAdd: MessageType.REACTION_ADD,
  reactionRemove: MessageType.REACTION_REMOVE,
  linkAdd: MessageType.LINK_ADD,
  linkRemove: MessageType.LINK_REMOVE,
  userDataAdd: MessageType.USER_DATA_ADD,
  keyAdd: MessageType.KEY_ADD,
  keyRemove: MessageType.KEY_REMOVE,
}

export type MessageDataInput = { fid: number; /** Farcaster time. */ timestamp: number; body: MessageBody }

export type BuildError = { kind: 'invalid'; detail: string }

const utf8Length = (s: string) => new TextEncoder().encode(s).length
const isFid = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0
const isUint32 = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 0xffff_ffff
/** An https URL of printable ASCII only: no spaces, control or bidi characters to disguise where it goes. */
const isHttpsUrl = (s: string) => /^https:\/\/[\x21-\x7e]+$/.test(s)

const castId = (w: Writer, ref: CastRef): BuildError | null => {
  const hash = fromHex(ref.hash, 20)
  if (!isFid(ref.fid) || !hash) return { kind: 'invalid', detail: 'a cast reference needs a FID and a 20-byte hash' }
  w.uint(1, ref.fid).bytes(2, hash)
  return null
}

/** The body, as its field in `MessageData`, or why it can't be built. */
const writeBody = (w: Writer, body: MessageBody): BuildError | null => {
  switch (body.type) {
    case 'castAdd': {
      const mentions = body.mentions ?? []
      const positions = body.mentionsPositions ?? []
      const embeds = body.embeds ?? []
      if (!body.text.trim() && !embeds.length) return { kind: 'invalid', detail: 'a cast needs text or an embed' }
      if (utf8Length(body.text) > MESSAGE_LIMITS.castText) return { kind: 'invalid', detail: `a cast is at most ${MESSAGE_LIMITS.castText} bytes` }
      if (mentions.length > MESSAGE_LIMITS.mentions || mentions.length !== positions.length) return { kind: 'invalid', detail: 'mentions and their positions must match, at most 10' }
      if (!mentions.every(isFid) || !positions.every(isUint32)) return { kind: 'invalid', detail: 'bad mention' }
      if (embeds.length > MESSAGE_LIMITS.embeds) return { kind: 'invalid', detail: `at most ${MESSAGE_LIMITS.embeds} embeds` }
      let problem: BuildError | null = null
      w.message(5, b => {
        b.packed(2, mentions)
        if (body.parent && 'hash' in body.parent) {
          const parent = body.parent
          b.message(3, c => { problem ??= castId(c, parent) })
        }
        if (body.parent && 'url' in body.parent) {
          if (!isHttpsUrl(body.parent.url)) problem ??= { kind: 'invalid', detail: 'a parent URL must be https' }
          if (utf8Length(body.parent.url) > MESSAGE_LIMITS.parentUrl) problem ??= { kind: 'invalid', detail: 'parent URL too long' }
          b.string(7, body.parent.url)
        }
        if (body.text) b.string(4, body.text)
        b.packed(5, positions)
        for (const e of embeds) {
          b.message(6, m => {
            if ('url' in e) {
              if (!isHttpsUrl(e.url) || utf8Length(e.url) > MESSAGE_LIMITS.embedUrl) problem ??= { kind: 'invalid', detail: 'an embed URL must be https and at most 256 bytes' }
              m.string(1, e.url)
            } else m.message(2, c => { problem ??= castId(c, e.cast) })
          })
        }
      })
      return problem
    }
    case 'castRemove': {
      const hash = fromHex(body.hash, 20)
      if (!hash) return { kind: 'invalid', detail: 'a cast hash is 20 bytes' }
      w.message(6, b => b.bytes(1, hash))
      return null
    }
    case 'reactionAdd':
    case 'reactionRemove': {
      let problem: BuildError | null = null
      w.message(7, b => {
        b.uint(1, body.reaction === 'like' ? 1 : 2)
        b.message(2, c => { problem = castId(c, body.target) })
      })
      return problem
    }
    case 'linkAdd':
    case 'linkRemove':
      if (!isFid(body.targetFid)) return { kind: 'invalid', detail: 'bad target FID' }
      w.message(14, b => b.string(1, 'follow').uint(3, body.targetFid))
      return null
    case 'userDataAdd': {
      const type = USER_DATA_TYPES[body.field]
      if (!type) return { kind: 'invalid', detail: 'unknown profile field' }
      if (utf8Length(body.value) > MESSAGE_LIMITS.userData[body.field]) return { kind: 'invalid', detail: `${body.field} is at most ${MESSAGE_LIMITS.userData[body.field]} bytes` }
      if ((body.field === 'pfp' || body.field === 'banner' || body.field === 'url') && body.value && !isHttpsUrl(body.value)) {
        return { kind: 'invalid', detail: `${body.field} must be an https URL` }
      }
      w.message(12, b => {
        b.uint(1, type)
        if (body.value) b.string(2, body.value)
      })
      return null
    }
    case 'keyAdd': {
      const k = body.body
      if (k.key.length !== 32 || !k.custodySignature.length || !k.metadata.length) return { kind: 'invalid', detail: 'incomplete key add' }
      if (![k.deadline, k.nonce, k.ttl].every(isUint32) || !k.scopes.length || !k.scopes.every(isUint32)) return { kind: 'invalid', detail: 'bad key add fields' }
      w.message(19, b => {
        b.bytes(1, k.key).uint(2, 1).bytes(3, k.custodySignature).uint(4, k.deadline).uint(5, k.nonce)
          .bytes(6, k.metadata).uint(7, 1).packed(9, k.scopes).uint(10, k.ttl)
      })
      return null
    }
    case 'keyRemove': {
      const k = body.body
      if (k.key.length !== 32 || ![k.deadline, k.nonce].every(isUint32) || (k.signatureType === 1) !== (k.signature.length > 0)) {
        return { kind: 'invalid', detail: 'bad key remove fields' }
      }
      w.message(20, b => {
        b.bytes(1, k.key)
        if (k.signature.length) b.bytes(2, k.signature)
        b.uint(3, k.signatureType).uint(4, k.deadline).uint(5, k.nonce)
      })
      return null
    }
  }
}

/** `MessageData` bytes on mainnet, or why the draft can't be built. */
export const encodeMessageData = (input: MessageDataInput): Result<Uint8Array, BuildError> => {
  if (!isFid(input.fid) || !isUint32(input.timestamp) || input.timestamp === 0) return err({ kind: 'invalid', detail: 'bad FID or timestamp' })
  const w = new Writer().uint(1, TYPE_OF[input.body.type]).uint(2, input.fid).uint(3, input.timestamp).uint(4, FARCASTER_MAINNET)
  const problem = writeBody(w, input.body)
  if (problem) return err(problem)
  const bytes = w.finish()
  if (bytes.length > MESSAGE_LIMITS.dataBytes) return err({ kind: 'invalid', detail: 'message too large' })
  return ok(bytes)
}

/** The message hash: BLAKE3 of the data bytes, truncated to 20 bytes. This is what the key signs. */
export const messageHash = (dataBytes: Uint8Array): Uint8Array => blake3(dataBytes, { dkLen: 20 })

/** The `Message` envelope Snapchain's `submitMessage` takes, with `data_bytes` and no decoded `data`. */
export const encodeEnvelope = (m: { dataBytes: Uint8Array; hash: Uint8Array; signature: Uint8Array; signer: Uint8Array }): Uint8Array =>
  new Writer()
    .bytes(2, m.hash).uint(3, HASH_SCHEME_BLAKE3)
    .bytes(4, m.signature).uint(5, SIGNATURE_SCHEME_ED25519)
    .bytes(6, m.signer)
    .bytes(7, m.dataBytes)
    .finish()
