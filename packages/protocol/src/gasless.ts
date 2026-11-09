import { keccak_256 } from '@noble/hashes/sha3.js'
import { concatBytes } from './bytes.ts'

// Gasless key registration (FIP-272): the three EIP-712 structs a custody address signs for
// Snapchain's own domain, and the ABI-encoded `SignedKeyRequest` metadata a `KEY_ADD`
// carries. The typehashes and domain separator are reference vectors matched against
// Snapchain's `core::validations::key` and `@farcaster/core` in gasless.test.ts.
//
// The vault signs nothing but these three digests. None of them can move the FID or change
// its recovery address: those are IdRegistry structs in a different domain.

const utf8 = (s: string) => new TextEncoder().encode(s)
const keccak = (b: Uint8Array) => keccak_256(b)

/** A uint256 word from a non-negative safe integer or bigint. */
const word = (n: number | bigint): Uint8Array => {
  let v = BigInt(n)
  if (v < 0n || v >= 1n << 256n) throw new RangeError('uint256 out of range')
  const out = new Uint8Array(32)
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

const addressWord = (address: Uint8Array): Uint8Array => {
  if (address.length !== 20) throw new RangeError('an address is 20 bytes')
  return concatBytes(new Uint8Array(12), address)
}

export const GASLESS_DOMAIN = { name: 'Farcaster KeyAdd', version: '1', chainId: 1 } as const

export const TYPES = {
  domain: 'EIP712Domain(string name,string version,uint256 chainId)',
  keyAdd: 'KeyAdd(uint256 fid,bytes key,uint32 keyType,uint32[] scopes,uint32 ttl,uint32 nonce,uint256 deadline)',
  keyRemove: 'KeyRemove(uint256 fid,bytes key,uint32 nonce,uint256 deadline)',
  signedKeyRequest: 'SignedKeyRequest(uint256 requestFid,bytes key,uint256 deadline)',
} as const

export const typeHash = (t: keyof typeof TYPES): Uint8Array => keccak(utf8(TYPES[t]))

export const domainSeparator = (): Uint8Array => keccak(concatBytes(
  typeHash('domain'), keccak(utf8(GASLESS_DOMAIN.name)), keccak(utf8(GASLESS_DOMAIN.version)), word(GASLESS_DOMAIN.chainId),
))

const digest = (structHash: Uint8Array) => keccak(concatBytes(Uint8Array.of(0x19, 0x01), domainSeparator(), structHash))

export type KeyAddFields = { fid: number; key: Uint8Array; scopes: readonly number[]; ttl: number; nonce: number; deadline: number }
export type KeyRemoveFields = { fid: number; key: Uint8Array; nonce: number; deadline: number }
export type SignedKeyRequestFields = { requestFid: number; key: Uint8Array; deadline: number }

export const keyAddDigest = (f: KeyAddFields): Uint8Array => digest(keccak(concatBytes(
  typeHash('keyAdd'), word(f.fid), keccak(f.key), word(1),
  keccak(concatBytes(...f.scopes.map(word))), word(f.ttl), word(f.nonce), word(f.deadline),
)))

export const keyRemoveDigest = (f: KeyRemoveFields): Uint8Array => digest(keccak(concatBytes(
  typeHash('keyRemove'), word(f.fid), keccak(f.key), word(f.nonce), word(f.deadline),
)))

export const signedKeyRequestDigest = (f: SignedKeyRequestFields): Uint8Array => digest(keccak(concatBytes(
  typeHash('signedKeyRequest'), word(f.requestFid), keccak(f.key), word(f.deadline),
)))

/**
 * `abi.encode(SignedKeyRequestMetadata)`: one tuple of (uint256 requestFid, address
 * requestSigner, bytes signature, uint256 deadline), the layout `KEY_ADD.metadata` carries.
 */
export const encodeSignedKeyRequestMetadata = (m: { requestFid: number; requestSigner: Uint8Array; signature: Uint8Array; deadline: number }): Uint8Array => {
  const padded = new Uint8Array(Math.ceil(m.signature.length / 32) * 32)
  padded.set(m.signature)
  return concatBytes(
    word(0x20),
    word(m.requestFid), addressWord(m.requestSigner), word(0x80), word(m.deadline),
    word(m.signature.length), padded,
  )
}
