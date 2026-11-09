import * as fc from '@farcaster/core'
import { ed25519 } from '@noble/curves/ed25519.js'
import { describe, expect, it } from 'vitest'
import { fromHex, toHex } from './bytes.ts'
import { encodeEnvelope, encodeMessageData, messageHash, type MessageBody } from './messages.ts'
import { verifyMessage } from './verify.ts'

// Reference vectors: every builder's bytes match @farcaster/core's ts-proto encoding, so the
// slim encoder can't drift from the protocol's reference implementation.

const FID = 1234
const TS = 150_000_000
const HASH = `0x${'ab'.repeat(20)}`
const dataOptions = { fid: FID, network: fc.FarcasterNetwork.MAINNET, timestamp: TS }

const ours = (body: MessageBody) => {
  const r = encodeMessageData({ fid: FID, timestamp: TS, body })
  if (!r.ok) throw new Error(r.error.detail)
  return toHex(r.value)
}
const theirs = async (p: Promise<fc.HubResult<fc.MessageData>>) => toHex(fc.MessageData.encode((await p)._unsafeUnwrap()).finish())

describe('message encoding matches @farcaster/core', () => {
  it('casts: text, mentions, embeds, replies and channels', async () => {
    const hashBytes = fromHex(HASH, 20)!
    expect(ours({ type: 'castAdd', text: 'hello world' }))
      .toBe(await theirs(fc.makeCastAddData({ text: 'hello world', embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], type: fc.CastType.CAST }, dataOptions)))
    expect(ours({ type: 'castAdd', text: 'hi  there', mentions: [3, 2], mentionsPositions: [3, 4], embeds: [{ url: 'https://example.com/a' }, { cast: { fid: 2, hash: HASH } }], parent: { fid: 3, hash: HASH } }))
      .toBe(await theirs(fc.makeCastAddData({
        text: 'hi  there', mentions: [3, 2], mentionsPositions: [3, 4], embedsDeprecated: [], type: fc.CastType.CAST,
        embeds: [{ url: 'https://example.com/a' }, { castId: { fid: 2, hash: hashBytes } }], parentCastId: { fid: 3, hash: hashBytes },
      }, dataOptions)))
    expect(ours({ type: 'castAdd', text: 'gm', parent: { url: 'https://warpcast.com/~/channel/dev' } }))
      .toBe(await theirs(fc.makeCastAddData({ text: 'gm', embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], type: fc.CastType.CAST, parentUrl: 'https://warpcast.com/~/channel/dev' }, dataOptions)))
    expect(ours({ type: 'castAdd', text: 'héllo ✨' }))
      .toBe(await theirs(fc.makeCastAddData({ text: 'héllo ✨', embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], type: fc.CastType.CAST }, dataOptions)))
  })

  it('deletes, reactions, follows and profile edits', async () => {
    const target = { fid: 3, hash: fromHex(HASH, 20)! }
    expect(ours({ type: 'castRemove', hash: HASH })).toBe(await theirs(fc.makeCastRemoveData({ targetHash: target.hash }, dataOptions)))
    expect(ours({ type: 'reactionAdd', reaction: 'like', target: { fid: 3, hash: HASH } }))
      .toBe(await theirs(fc.makeReactionAddData({ type: fc.ReactionType.LIKE, targetCastId: target }, dataOptions)))
    expect(ours({ type: 'reactionRemove', reaction: 'recast', target: { fid: 3, hash: HASH } }))
      .toBe(await theirs(fc.makeReactionRemoveData({ type: fc.ReactionType.RECAST, targetCastId: target }, dataOptions)))
    expect(ours({ type: 'linkAdd', targetFid: 3 })).toBe(await theirs(fc.makeLinkAddData({ type: 'follow', targetFid: 3 }, dataOptions)))
    expect(ours({ type: 'linkRemove', targetFid: 3 })).toBe(await theirs(fc.makeLinkRemoveData({ type: 'follow', targetFid: 3 }, dataOptions)))
    expect(ours({ type: 'userDataAdd', field: 'bio', value: 'builder' }))
      .toBe(await theirs(fc.makeUserDataAddData({ type: fc.UserDataType.BIO, value: 'builder' }, dataOptions)))
    expect(ours({ type: 'userDataAdd', field: 'display', value: '' }))
      .toBe(await theirs(fc.makeUserDataAddData({ type: fc.UserDataType.DISPLAY, value: '' }, dataOptions)))
  })

  it('gasless key add and self-revocation', async () => {
    const key = new Uint8Array(32).fill(7)
    const body = { key, custodySignature: new Uint8Array(65).fill(1), deadline: TS + 600, nonce: 4, metadata: new Uint8Array(192).fill(2), scopes: [1, 2, 3], ttl: 2_592_000 }
    // core's makeKeyAddData validates the signatures, so these compare against its raw encoder.
    const raw = (d: Partial<fc.MessageData>) => toHex(fc.MessageData.encode(fc.MessageData.fromPartial({ ...dataOptions, ...d })).finish())
    expect(ours({ type: 'keyAdd', body })).toBe(raw({
      type: fc.MessageType.KEY_ADD,
      keyAddBody: { ...body, keyType: 1, metadataType: 1, registrationTxHash: new Uint8Array(), scopes: [1, 2, 3] },
    }))
    const self = fc.makeKeyRemoveBodySelfRevoke({ key, nonce: 1, deadline: TS + 600 })._unsafeUnwrap()
    expect(ours({ type: 'keyRemove', body: { key, signature: new Uint8Array(), signatureType: 2, deadline: TS + 600, nonce: 1 } }))
      .toBe(raw({ type: fc.MessageType.KEY_REMOVE, keyRemoveBody: self }))
    const custody = { key, signature: new Uint8Array(65).fill(3), signatureType: 1 as const, deadline: TS + 600, nonce: 5 }
    expect(ours({ type: 'keyRemove', body: custody })).toBe(raw({ type: fc.MessageType.KEY_REMOVE, keyRemoveBody: custody }))
  })

  it('hashes like core and produces envelopes the verifier accepts', async () => {
    const secret = new Uint8Array(32).fill(9)
    const signer = new fc.NobleEd25519Signer(secret)
    const data = (await fc.makeCastAddData({ text: 'hello', embeds: [], embedsDeprecated: [], mentions: [], mentionsPositions: [], type: fc.CastType.CAST }, dataOptions))._unsafeUnwrap()
    const msg = (await fc.makeMessage<fc.CastAddMessage>(data, signer))._unsafeUnwrap()
    const r = encodeMessageData({ fid: FID, timestamp: TS, body: { type: 'castAdd', text: 'hello' } })
    if (!r.ok) throw new Error()
    const hash = messageHash(r.value)
    expect(toHex(hash)).toBe(toHex(msg.hash))
    const envelope = encodeEnvelope({ dataBytes: r.value, hash, signature: ed25519.sign(hash, secret), signer: ed25519.getPublicKey(secret) })
    const v = verifyMessage(envelope)
    expect(v.ok && v.value).toMatchObject({ type: 1, fid: FID, timestamp: TS, hash: toHex(msg.hash) })
    // core's own envelope, re-encoded without `data`, verifies too.
    expect(verifyMessage(fc.Message.encode({ ...msg, data: undefined }).finish()).ok).toBe(true)
  })
})

describe('the builders refuse what Snapchain would', () => {
  const bad = (body: MessageBody) => encodeMessageData({ fid: FID, timestamp: TS, body }).ok
  it('limits text, embeds, mentions and URLs', () => {
    expect(bad({ type: 'castAdd', text: 'a'.repeat(320) })).toBe(true)
    expect(bad({ type: 'castAdd', text: 'a'.repeat(321) })).toBe(false)
    expect(bad({ type: 'castAdd', text: 'é'.repeat(161) })).toBe(false)
    expect(bad({ type: 'castAdd', text: '' })).toBe(false)
    expect(bad({ type: 'castAdd', text: '  \n ' })).toBe(false)
    expect(bad({ type: 'castAdd', text: 'x', embeds: [{ url: 'https://a.b/\u202egnp.exe' }] })).toBe(false)
    expect(bad({ type: 'castAdd', text: 'x', embeds: [{ url: 'https://a.b/\u0007' }] })).toBe(false)
    expect(bad({ type: 'castAdd', text: 'x', embeds: [{ url: 'http://example.com' }] })).toBe(false)
    expect(bad({ type: 'castAdd', text: 'x', embeds: [{ url: 'https://a.b' }, { url: 'https://a.b' }, { url: 'https://a.b' }] })).toBe(false)
    expect(bad({ type: 'castAdd', text: 'x', mentions: [1], mentionsPositions: [] })).toBe(false)
    expect(bad({ type: 'castAdd', text: 'x', parent: { fid: 1, hash: '0x12' } })).toBe(false)
    expect(bad({ type: 'castAdd', text: 'x', parent: { url: 'javascript:alert(1)' } })).toBe(false)
    expect(bad({ type: 'userDataAdd', field: 'display', value: 'x'.repeat(33) })).toBe(false)
    expect(bad({ type: 'userDataAdd', field: 'pfp', value: 'http://x' })).toBe(false)
    expect(bad({ type: 'linkAdd', targetFid: 0 })).toBe(false)
    expect(encodeMessageData({ fid: 0, timestamp: TS, body: { type: 'linkAdd', targetFid: 3 } }).ok).toBe(false)
  })
})

describe('verifyMessage', () => {
  const secret = new Uint8Array(32).fill(5)
  const make = (mutate: (p: { dataBytes: Uint8Array; hash: Uint8Array; signature: Uint8Array; signer: Uint8Array }) => void = () => {}) => {
    const r = encodeMessageData({ fid: FID, timestamp: TS, body: { type: 'castAdd', text: 'hello' } })
    if (!r.ok) throw new Error()
    const hash = messageHash(r.value)
    const parts = { dataBytes: r.value, hash, signature: ed25519.sign(hash, secret), signer: ed25519.getPublicKey(secret) }
    mutate(parts)
    return encodeEnvelope(parts)
  }
  it('refuses a valid hash with a forged signature, other networks, and duplicated or unknown fields', () => {
    // The data and hash are untouched; only the signature is wrong.
    expect(verifyMessage(make(p => { p.signature = ed25519.sign(p.hash, new Uint8Array(32).fill(6)) })).ok).toBe(false)
    const r = encodeMessageData({ fid: FID, timestamp: TS, body: { type: 'castAdd', text: 'hello' } })
    if (!r.ok) throw new Error()
    const testnet = Uint8Array.from(r.value)
    testnet[testnet.indexOf(0x20) + 1] = 2 // network = 2
    const sign = (dataBytes: Uint8Array) => { const hash = messageHash(dataBytes); return encodeEnvelope({ dataBytes, hash, signature: ed25519.sign(hash, secret), signer: ed25519.getPublicKey(secret) }) }
    expect(verifyMessage(sign(testnet))).toEqual({ ok: false, error: 'not a mainnet message' })
    // A second envelope field of the same number, or one we never write, is refused.
    expect(verifyMessage(new Uint8Array([...make(), 0x12, 0x01, 0x00])).ok).toBe(false)
    expect(verifyMessage(new Uint8Array([...make(), 0x0a, 0x00])).ok).toBe(false)
    // A FID repeated inside the data counts as the last one, as Snapchain reads it.
    const twice = new Uint8Array([...r.value, 0x10, 0x02])
    const v = verifyMessage(sign(twice))
    expect(v.ok && v.value.fid).toBe(2)
  })

  it('refuses tampering, wrong keys and junk', () => {
    expect(verifyMessage(make()).ok).toBe(true)
    expect(verifyMessage(make(p => { p.dataBytes = Uint8Array.from(p.dataBytes); p.dataBytes[p.dataBytes.length - 1]! ^= 1 })).ok).toBe(false)
    expect(verifyMessage(make(p => { p.signer = ed25519.getPublicKey(new Uint8Array(32).fill(6)) })).ok).toBe(false)
    expect(verifyMessage(make(p => { p.signature = new Uint8Array(64) })).ok).toBe(false)
    expect(verifyMessage(new Uint8Array([0xff, 0xff, 0xff])).ok).toBe(false)
    expect(verifyMessage(new Uint8Array(5_000)).ok).toBe(false)
    expect(verifyMessage(new Uint8Array()).ok).toBe(false)
  })
})
