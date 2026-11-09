import * as fc from '@farcaster/core'
import { hashTypedData } from 'viem'
import { describe, expect, it } from 'vitest'
import { fromHex, toHex } from './bytes.ts'
import { domainSeparator, encodeSignedKeyRequestMetadata, keyAddDigest, keyRemoveDigest, signedKeyRequestDigest, typeHash } from './gasless.ts'
import { keyFingerprint, POSTING_SCOPES } from './key-policy.ts'

// Reference vectors (sealed core): the typehashes and domain separator from Snapchain's
// `core::validations::key` (commit 961d12b),
// and every digest against viem's EIP-712 implementation over @farcaster/core's type tables.

describe('gasless EIP-712', () => {
  it('matches the typehashes and domain separator Snapchain verifies', () => {
    expect(toHex(domainSeparator())).toBe('0x707019aeb448daaaf80d91a73d5f686b66e14a1a69ba6bf4ed39331d72d9ac2a')
    expect(toHex(typeHash('keyAdd'))).toBe('0x877e76191c085cf949012706bb292ce3315d25bf6a49bef6eb74755eef39caa7')
    expect(toHex(typeHash('keyRemove'))).toBe('0xc6ce600cc73c69d40a81bb838c7641c348328b963a032ce30dc45b254f9ea5cd')
    expect(toHex(typeHash('signedKeyRequest'))).toBe('0x16be47f1f1f50a66a48db64eba3fd35c21439c23622e513aab5b902018aec438')
  })

  const key = fromHex(`0x${'5a'.repeat(32)}`, 32)!
  it('KeyAdd digests match viem', () => {
    for (const scopes of [[1], [1, 2, 3, 4, 5, 6, 11], [11, 1]]) {
      const f = { fid: 1234, key, scopes, ttl: 2_592_000, nonce: 3, deadline: 150_000_600 }
      expect(toHex(keyAddDigest(f))).toBe(hashTypedData({
        ...fc.GASLESS_KEY_ADD_EIP_712_TYPES, primaryType: 'KeyAdd',
        message: { fid: 1234n, key: toHex(key), keyType: 1, scopes, ttl: f.ttl, nonce: f.nonce, deadline: BigInt(f.deadline) },
      }))
    }
  })

  it('KeyRemove and SignedKeyRequest digests match viem', () => {
    expect(toHex(keyRemoveDigest({ fid: 99, key, nonce: 7, deadline: 1_000 }))).toBe(hashTypedData({
      ...fc.GASLESS_KEY_REMOVE_EIP_712_TYPES, primaryType: 'KeyRemove',
      message: { fid: 99n, key: toHex(key), nonce: 7, deadline: 1_000n },
    }))
    expect(toHex(signedKeyRequestDigest({ requestFid: 99, key, deadline: 1_000 }))).toBe(hashTypedData({
      ...fc.GASLESS_SIGNED_KEY_REQUEST_EIP_712_TYPES, primaryType: 'SignedKeyRequest',
      message: { requestFid: 99n, key: toHex(key), deadline: 1_000n },
    }))
  })

  it('encodes SignedKeyRequest metadata like core', () => {
    const m = { requestFid: 1234, requestSigner: fromHex(`0x${'e9'.repeat(20)}`, 20)!, signature: new Uint8Array(65).fill(4), deadline: 150_000_600 }
    const theirs = fc.encodeGaslessSignedKeyRequestMetadata({ requestFid: 1234n, requestSigner: toHex(m.requestSigner), signature: m.signature, deadline: 150_000_600n })._unsafeUnwrap()
    expect(toHex(encodeSignedKeyRequestMetadata(m))).toBe(toHex(theirs))
  })
})

describe('the app key policy', () => {
  it('grants posting scopes only, and fingerprints keys in five groups', () => {
    expect(POSTING_SCOPES).toEqual([1, 2, 3, 4, 5, 6, 11])
    expect(keyFingerprint(new Uint8Array(32).fill(1))).toBe('0101-0101-0101-0101-0101')
  })
})
