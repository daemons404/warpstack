import { ed25519 } from '@noble/curves/ed25519.js'
import {
  encodeEnvelope, encodeMessageData, encodeSignedKeyRequestMetadata, messageHash, toBase64Url, toFarcasterTime, type Timestamp,
} from '@warpstack/protocol'
import { describe, expect, it } from 'vitest'
import { FakeSnapchain } from '../src/adapters/snapchain-fake.ts'
import type { Admission } from '../src/config.ts'
import { keyAddRequestFid } from '../src/core/key-add.ts'
import { Writes } from '../src/writes.ts'

// A private deployment relays a `KEY_ADD`, its one message without a session, only for allowed
// FIDs or keys its app FID requested, decided from the message before anything reaches the node.

const NOW = 1_800_000_000
const APP = 9_999
const secret = new Uint8Array(32).fill(3)

const keyAddData = (fid: number, requestFid: number) => {
  const metadata = encodeSignedKeyRequestMetadata({ requestFid, requestSigner: new Uint8Array(20).fill(1), signature: new Uint8Array(65).fill(2), deadline: NOW + 3_600 })
  const data = encodeMessageData({
    fid, timestamp: toFarcasterTime(NOW as Timestamp),
    body: { type: 'keyAdd', body: { key: new Uint8Array(32).fill(5), custodySignature: new Uint8Array(65).fill(6), deadline: NOW + 3_600, nonce: 1, metadata, scopes: [1], ttl: 0 } },
  })
  if (!data.ok) throw new Error(data.error.detail)
  return data.value
}
const keyAdd = (fid: number, requestFid: number) => {
  const dataBytes = keyAddData(fid, requestFid)
  const hash = messageHash(dataBytes)
  return toBase64Url(encodeEnvelope({ dataBytes, hash, signature: ed25519.sign(hash, secret), signer: ed25519.getPublicKey(secret) }))
}

const relay = async (admission: Admission, fid: number, requestFid: number) => {
  const snap = new FakeSnapchain()
  const writes = new Writes(snap, { now: () => NOW as Timestamp }, false, false, admission)
  const r = await writes.submit(keyAdd(fid, requestFid), { sessionFid: null, limitFid: async () => true })
  return { r, relayed: snap.submitted.length }
}

describe('the request FID in a KEY_ADD', () => {
  it('is read from the body\'s signed metadata', () => {
    expect(keyAddRequestFid(keyAddData(1234, 1234))).toBe(1234)
    expect(keyAddRequestFid(keyAddData(1234, APP))).toBe(APP)
  })

  it('is null for anything that is not a well-formed KEY_ADD', () => {
    expect(keyAddRequestFid(new Uint8Array([0xff, 0xff]))).toBeNull()
    expect(keyAddRequestFid(new Uint8Array())).toBeNull()
  })
})

describe('the KEY_ADD relay on a private deployment', () => {
  it('relays only for allowed FIDs, refusing others before the node', async () => {
    const allowed: Admission = { public: false, allowed: new Set([1234]) }
    expect(await relay(allowed, 1234, 1234)).toMatchObject({ r: { ok: true }, relayed: 1 })
    expect(await relay(allowed, 42, 42)).toEqual({ r: { ok: false, error: { kind: 'rejected', detail: 'this deployment does not accept keys for this FID' } }, relayed: 0 })
  })

  it('relays keys the app FID requested, with APP_FID', async () => {
    const app: Admission = { public: false, allowed: new Set(), appFid: APP }
    expect(await relay(app, 42, APP)).toMatchObject({ r: { ok: true }, relayed: 1 })
    expect(await relay(app, 42, 42)).toMatchObject({ r: { ok: false }, relayed: 0 })
  })

  it('relays anyone\'s when public', async () => {
    expect(await relay({ public: true, allowed: new Set() }, 42, 42)).toMatchObject({ r: { ok: true }, relayed: 1 })
  })
})
