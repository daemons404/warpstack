import { ed25519 } from '@noble/curves/ed25519.js'
import { encodeEnvelope, encodeMessageData, messageHash, toBase64Url, toFarcasterTime, type EventId, type Fid, type MessageBody, type ShardIndex, type Timestamp } from '@warpstack/protocol'
import { describe, expect, it } from 'vitest'
import { HmacMac } from '../src/adapters/hmac.ts'
import { IndexMaintenance } from '../src/adapters/index-maintenance.ts'
import { IndexReader } from '../src/adapters/index-reader.ts'
import { SqlIndexWriter } from '../src/adapters/index-writer.ts'
import { FakeSnapchain } from '../src/adapters/snapchain-fake.ts'
import { foldPage } from '../src/core/fold.ts'
import type { Message } from '../src/core/snapchain-types.ts'
import { Reads } from '../src/reads.ts'
import { Writes, type Submitter } from '../src/writes.ts'
import { block, castAdd, follow, merge, reaction } from './build.ts'
import { MemorySql } from './sqlite.ts'

const T = 1_793_000_000
const NOW = T + 600
const ME = 1234 as Fid

const setup = async () => {
  const db = new MemorySql()
  const writer = new SqlIndexWriter(db, () => T * 1_000)
  const snap = new FakeSnapchain()
  for (const shard of [1, 2] as ShardIndex[]) await writer.resetCursor({ shard, lastEventId: 0 as EventId, lastBlockTs: (T - 1_000) as Timestamp })
  const clock = { now: () => NOW as Timestamp }
  const reads = new Reads(new IndexReader(db), new IndexMaintenance(db), snap, new HmacMac('k'.repeat(32)), clock)
  const ingest = async (messages: Message[]) => {
    const cur = (await writer.cursor(1 as ShardIndex))!
    const f = foldPage([...messages.map(m => merge(m)), block(NOW - 30)], cur.lastEventId)
    expect((await writer.applyPage(cur, { shard: 1 as ShardIndex, lastEventId: f.lastEventId, lastBlockTs: f.lastBlockTs! }, f.ops)).ok).toBe(true)
    await db.batch([{ sql: 'UPDATE ingest_cursor SET last_block_ts = ?1', params: [NOW - 30] }])
  }
  return { db, snap, reads, ingest, clock }
}

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`)
  return r.value
}

describe('home feed', () => {
  it('shows top-level casts from followed accounts and the viewer, not replies or strangers', async () => {
    const { snap, reads, ingest } = await setup()
    snap.add(follow({ fid: ME, ts: T - 5_000, target: 2 }), follow({ fid: ME, ts: T - 5_000, target: 3 }))
    const mine = castAdd({ fid: ME, ts: T + 1 })
    const theirs = castAdd({ fid: 2, ts: T + 2 })
    const reply = castAdd({ fid: 3, ts: T + 3, parent: { fid: 2, hash: theirs.hash } })
    const stranger = castAdd({ fid: 9, ts: T + 4 })
    await ingest([mine, theirs, reply, stranger])
    const page = unwrap(await reads.home(ME))
    expect(page.items.map(c => c.hash)).toEqual([theirs.hash, mine.hash])
    expect(page.next).toEqual({ kind: 'horizon' })
  })

  it('caches the follow list, so a second read does not page the node', async () => {
    const { snap, reads } = await setup()
    snap.add(follow({ fid: ME, ts: T, target: 2 }))
    await reads.home(ME)
    const calls = snap.calls
    await reads.home(ME)
    expect(snap.calls).toBe(calls)
  })
})

describe('viewer state and account', () => {
  it('lists the viewer\'s likes, recasts and follows', async () => {
    const { snap, reads } = await setup()
    const target = { fid: 2, hash: `0x${'aa'.repeat(20)}` }
    snap.add(reaction({ fid: ME, ts: T, kind: 'like', target }), follow({ fid: ME, ts: T, target: 2 }))
    snap.messages.at(0)!.data.type = 'MESSAGE_TYPE_REACTION_ADD'
    const v = unwrap(await reads.viewer(ME))
    expect(v).toEqual({ likes: [target.hash], recasts: [], following: [2], complete: true })
  })

  it('reads custody, keys and nonces, and is NOT_FOUND for a FID with no custody', async () => {
    const { snap, reads } = await setup()
    snap.custody.set(ME, `0x${'e9'.repeat(20)}`)
    snap.signersByFid.set(ME, { userNonce: 4, requesterNonces: new Map([[ME, 2]]), keys: [{ key: `0x${'01'.repeat(32)}`, source: 'gasless', scopes: [1, 3], requestFid: ME, expiresAt: T + 99 }] })
    const a = unwrap(await reads.account(ME))
    expect(a).toMatchObject({ custody: `0x${'e9'.repeat(20)}`, userNonce: 4, appNonce: 2, keys: [{ source: 'gasless', scopes: [1, 3], requestFid: ME }] })
    expect(await reads.account(99 as Fid)).toEqual({ ok: false, error: { kind: 'not_found' } })
  })
})

const varint = (n: number) => { const out: number[] = []; while (n >= 0x80) { out.push((n % 0x80) | 0x80); n = Math.floor(n / 0x80) } out.push(n); return out }

describe('writes', () => {
  const secret = new Uint8Array(32).fill(7)
  const signed = (body: MessageBody, o: { fid?: number; ts?: number } = {}) => {
    const data = encodeMessageData({ fid: o.fid ?? ME, timestamp: toFarcasterTime((o.ts ?? NOW) as Timestamp), body })
    if (!data.ok) throw new Error(data.error.detail)
    const hash = messageHash(data.value)
    return toBase64Url(encodeEnvelope({ dataBytes: data.value, hash, signature: ed25519.sign(hash, secret), signer: ed25519.getPublicKey(secret) }))
  }
  const make = (readOnly = false) => {
    const snap = new FakeSnapchain()
    return { snap, writes: new Writes(snap, { now: () => NOW as Timestamp }, readOnly) }
  }
  const limited: number[] = []
  const as = (sessionFid: number | null, allow = true): Submitter => ({ sessionFid, limitFid: async fid => { limited.push(fid); return allow } })
  const me = as(ME)

  it('submits a verified message from the session\'s own FID', async () => {
    const { snap, writes } = make()
    const r = await writes.submit(signed({ type: 'castAdd', text: 'gm' }), me)
    expect(r.ok).toBe(true)
    expect(snap.submitted).toHaveLength(1)
  })

  it('needs a session whose FID is the message\'s, except for KEY_ADD', async () => {
    const { snap, writes } = make()
    expect(await writes.submit(signed({ type: 'castAdd', text: 'gm' }), as(null))).toEqual({ ok: false, error: { kind: 'no_session' } })
    expect(await writes.submit(signed({ type: 'castAdd', text: 'gm' }, { fid: 2 }), me)).toEqual({ ok: false, error: { kind: 'fid_mismatch' } })
    expect(snap.submitted).toHaveLength(0)
    const key = ed25519.getPublicKey(secret)
    const keyAdd = signed({ type: 'keyAdd', body: { key, custodySignature: new Uint8Array(65).fill(1), deadline: 1, nonce: 1, metadata: new Uint8Array(32).fill(1), scopes: [1], ttl: 60 } })
    expect((await writes.submit(keyAdd, as(null))).ok).toBe(true)
    expect(await make(true).writes.submit(signed({ type: 'castAdd', text: 'gm' }), me)).toEqual({ ok: false, error: { kind: 'read_only' } })
  })

  it('limits per FID only after the signature checks out', async () => {
    const { writes } = make()
    limited.length = 0
    const good = signed({ type: 'castAdd', text: 'gm' })
    await writes.submit(good.slice(0, -2) + (good.endsWith('A') ? 'B' : 'A') + good.slice(-1), me)
    expect(limited).toEqual([])
    expect(await writes.submit(good, as(ME, false))).toEqual({ ok: false, error: { kind: 'rate_limited' } })
    expect(limited).toEqual([ME])
  })

  it('refuses tampered, stale and future messages before the node sees them', async () => {
    const { snap, writes } = make()
    const good = signed({ type: 'castAdd', text: 'gm' })
    const tampered = good.slice(0, -2) + (good.endsWith('A') ? 'B' : 'A') + good.slice(-1)
    expect((await writes.submit(tampered, me)).ok).toBe(false)
    expect((await writes.submit('not base64!', me)).ok).toBe(false)
    expect((await writes.submit(signed({ type: 'castAdd', text: 'gm' }, { ts: NOW - 7_200 }), me)).ok).toBe(false)
    expect((await writes.submit(signed({ type: 'castAdd', text: 'gm' }, { ts: NOW + 3_600 }), me)).ok).toBe(false)
    expect(snap.submitted).toHaveLength(0)
  })

  it('passes the node\'s refusal through, and names an inactive key', async () => {
    const { snap, writes } = make()
    snap.reject = 'bad_request.duplicate'
    expect(await writes.submit(signed({ type: 'linkAdd', targetFid: 2 }), me)).toEqual({ ok: false, error: { kind: 'rejected', detail: 'bad_request.duplicate' } })
    snap.reject = 'bad_request.validation_failure/invalid signer'
    expect(await writes.submit(signed({ type: 'linkAdd', targetFid: 2 }), me)).toEqual({ ok: false, error: { kind: 'key_inactive' } })
  })

  it('submits only posting and key messages', async () => {
    const { snap, writes } = make()
    // A verification is a valid message an app key could sign, but this deployment doesn't relay it.
    const data = new Uint8Array([0x08, 0x07, 0x10, 0xbd, 0x0d, 0x18, ...varint(toFarcasterTime(NOW as Timestamp)), 0x20, 0x01])
    const hash = messageHash(data)
    const envelope = toBase64Url(encodeEnvelope({ dataBytes: data, hash, signature: ed25519.sign(hash, secret), signer: ed25519.getPublicKey(secret) }))
    expect(await writes.submit(envelope, me)).toMatchObject({ ok: false, error: { kind: 'rejected' } })
    expect(snap.submitted).toHaveLength(0)
  })

})
