import { readFileSync } from 'node:fs'
import { ed25519 } from '@noble/curves/ed25519.js'
import * as fc from '@farcaster/core'
import {
  APP_KEY_TTL_SECONDS, concatBytes, encodeMessageData, encodeSignedKeyRequestMetadata, fromHex, messageHash, POSTING_SCOPES, toHex, type MessageDataInput,
} from '@warpstack/protocol'
import { mnemonicToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

// Reference vectors for the native vault (sealed core), in `wallet/vectors/native.json`, which
// `native/rust/tests/vectors.rs` reads too. This test rebuilds every value from outside
// implementations: viem derives the accounts and signs the EIP-712 messages over
// @farcaster/core's type tables, and noble signs the app key's messages. If the file and this
// test disagree, the test fails; the file changes only by hand, with a human's approval.

const VECTORS = new URL('../../vectors/native.json', import.meta.url)

const PHRASE = 'test test test test test test test test test test test junk'
const NOW = 150_000_000
const DEADLINE = NOW + 600
const SEED = new Uint8Array(32).fill(7)
const APP_KEY = ed25519.getPublicKey(SEED)
const OTHER_KEY = new Uint8Array(32).fill(0x5a)
const account = (i: number) => mnemonicToAccount(PHRASE, { addressIndex: i })
const custody = (i: number) => fromHex(account(i).address.toLowerCase(), 20)!

const signed = (purpose: string, input: MessageDataInput) => {
  const data = encodeMessageData(input)
  if (!data.ok) throw new Error(data.error.detail)
  const hash = messageHash(data.value)
  return { purpose, fid: input.fid, data: toHex(data.value), hash: toHex(hash), signature: toHex(ed25519.sign(hash, SEED)) }
}

// Session challenges, built here byte by byte rather than with protocol's `sessionPreimage`, so
// the vectors don't trust the code they check. Rust must sign each `sessions` entry exactly and
// refuse each `sessionRefusals` entry.
const utf8 = (s: string) => new TextEncoder().encode(s)
const session = (origin: string, nonce: Uint8Array) => {
  const o = utf8(origin)
  const preimage = concatBytes(utf8('warpstack-session-v1'), Uint8Array.of(o.length >> 8, o.length & 0xff), o, nonce)
  return { origin, nonce: toHex(nonce), preimage: toHex(preimage), signature: toHex(ed25519.sign(preimage, SEED)) }
}
const NONCE = Uint8Array.from({ length: 32 }, (_, i) => i)

describe('native vault vectors', () => {
  it('match viem, @farcaster/core and noble', async () => {
    const signer = account(3)
    const requestSig = fromHex(await signer.signTypedData({
      ...fc.GASLESS_SIGNED_KEY_REQUEST_EIP_712_TYPES, primaryType: 'SignedKeyRequest',
      message: { requestFid: 1234n, key: toHex(APP_KEY), deadline: BigInt(DEADLINE) },
    }), 65)!
    const metadata = encodeSignedKeyRequestMetadata({ requestFid: 1234, requestSigner: custody(3), signature: requestSig, deadline: DEADLINE })
    const custodySignature = fromHex(await signer.signTypedData({
      ...fc.GASLESS_KEY_ADD_EIP_712_TYPES, primaryType: 'KeyAdd',
      message: { fid: 1234n, key: toHex(APP_KEY), keyType: 1, scopes: [...POSTING_SCOPES], ttl: APP_KEY_TTL_SECONDS, nonce: 3, deadline: BigInt(DEADLINE) },
    }), 65)!
    const removeSig = fromHex(await account(0).signTypedData({
      ...fc.GASLESS_KEY_REMOVE_EIP_712_TYPES, primaryType: 'KeyRemove',
      message: { fid: 1234n, key: toHex(OTHER_KEY), nonce: 4, deadline: BigInt(DEADLINE) },
    }), 65)!

    const vectors = {
      phrase: PHRASE,
      now: NOW,
      appKeySeed: toHex(SEED),
      appKey: toHex(APP_KEY),
      keyAdd: {
        fid: 1234, custody: toHex(custody(3)), nonce: 3, deadline: DEADLINE,
        accountIndex: 3, custodySignature: toHex(custodySignature), metadata: toHex(metadata),
      },
      keyRemove: {
        fid: 1234, key: toHex(OTHER_KEY), custody: toHex(custody(0)), nonce: 4, deadline: DEADLINE,
        accountIndex: 0, signature: toHex(removeSig),
      },
      messages: [
        signed('posting', { fid: 1234, timestamp: NOW, body: { type: 'castAdd', text: 'gm from the phone', mentions: [3], mentionsPositions: [0], embeds: [{ url: 'https://example.com/a' }] } }),
        signed('posting', { fid: 1234, timestamp: NOW, body: { type: 'reactionAdd', reaction: 'like', target: { fid: 3, hash: `0x${'ab'.repeat(20)}` } } }),
        signed('posting', { fid: 1234, timestamp: NOW, body: { type: 'userDataAdd', field: 'bio', value: 'hello' } }),
        signed('ownKeyAdd', { fid: 1234, timestamp: NOW, body: { type: 'keyAdd', body: {
          key: APP_KEY, custodySignature, deadline: DEADLINE, nonce: 3, metadata, scopes: [...POSTING_SCOPES], ttl: APP_KEY_TTL_SECONDS,
        } } }),
        signed('selfRemove', { fid: 1234, timestamp: NOW, body: { type: 'keyRemove', body: { key: APP_KEY, signature: new Uint8Array(), signatureType: 2, nonce: 5, deadline: DEADLINE } } }),
        signed('custodyRemove', { fid: 1234, timestamp: NOW, body: { type: 'keyRemove', body: { key: OTHER_KEY, signature: removeSig, signatureType: 1, nonce: 4, deadline: DEADLINE } } }),
      ],
    }
    const sessions = {
      sessions: [
        session('https://test-warpstack.ngrok.io', NONCE),
        session('http://localhost:8787', new Uint8Array(32).fill(0xff)),
        session(`https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(51)}.xyz`, NONCE),
      ],
      sessionRefusals: [
        { origin: 'http://warpstack.xyz', nonce: toHex(NONCE) },
        { origin: 'https://warpstack.xyz/', nonce: toHex(NONCE) },
        { origin: 'https://Warpstack.xyz', nonce: toHex(NONCE) },
        { origin: 'http://192.168.1.2:8787', nonce: toHex(NONCE) },
        { origin: `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(52)}.xyz`, nonce: toHex(NONCE) },
        { origin: 'https://warpstack.xyz', nonce: toHex(NONCE.slice(0, 31)) },
        { origin: 'https://warpstack.xyz', nonce: toHex(new Uint8Array(20)) },
      ],
    }
    expect(JSON.parse(readFileSync(VECTORS, 'utf8'))).toEqual({ ...vectors, ...sessions })
  })
})
