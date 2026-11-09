import { ed25519 } from '@noble/curves/ed25519.js'
import { encodeEnvelope, encodeMessageData, messageHash, toBase64Url, toFarcasterTime, type Timestamp } from '@warpstack/protocol'
import { env, exports } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

// The write path in workerd against real D1: signature checks run in the Worker (the protocol
// tests cover each refusal) and refusals carry their status. sessions.workers.test.ts covers
// writes with a session.

const DB = (env as unknown as { DB: D1Database }).DB
const worker = (exports as unknown as { default: { fetch: (r: Request) => Promise<Response> } }).default
const NOW = Math.floor(Date.now() / 1000)
const secret = new Uint8Array(32).fill(3)

const signed = (fid: number, text = 'gm') => {
  const data = encodeMessageData({ fid, timestamp: toFarcasterTime(NOW as Timestamp), body: { type: 'castAdd', text } })
  if (!data.ok) throw new Error(data.error.detail)
  const hash = messageHash(data.value)
  return toBase64Url(encodeEnvelope({ dataBytes: data.value, hash, signature: ed25519.sign(hash, secret), signer: ed25519.getPublicKey(secret) }))
}
const submit = (message: string) => worker.fetch(new Request('https://reader.test/api/messages', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }),
}))

beforeAll(async () => {
  await DB.batch([
    DB.prepare('INSERT OR REPLACE INTO ingest_cursor VALUES (1, 1, 1, ?1, ?2), (2, 1, 1, ?1, ?2)').bind(NOW - 5, NOW - 3_600),
    DB.prepare(`INSERT INTO casts (hash, fid, ts, reply, parent_hash, parent_fid, channel, type, text, embeds, mentions)
                VALUES (?1, 77, ?2, 0, NULL, NULL, NULL, 'cast', 'from a followed account', '[]', '[]')`).bind(`0x${'d'.repeat(40)}`, NOW - 30),
    DB.prepare(`INSERT INTO casts (hash, fid, ts, reply, parent_hash, parent_fid, channel, type, text, embeds, mentions)
                VALUES (?1, 78, ?2, 0, NULL, NULL, NULL, 'cast', 'from a stranger', '[]', '[]')`).bind(`0x${'e'.repeat(40)}`, NOW - 20),
    DB.prepare('INSERT INTO following_cache (fid, fids, complete, ts) VALUES (1234, ?1, 1, ?2)').bind('[77]', NOW),
  ])
})

describe('messages.submit in the Worker', () => {
  it('refuses a cast without a session, before the node', async () => {
    const res = await submit(signed(1234))
    expect(res.status).toBe(401)
    expect(((await res.json()) as { data: { reason: string } }).data.reason).toBe('session')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('refuses a tampered message as REJECTED (here the data changes, so the hash check catches it)', async () => {
    const good = signed(1234)
    const res = await submit(good.slice(0, 20) + (good[20] === 'A' ? 'B' : 'A') + good.slice(21))
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('REJECTED')
  })

  it('refuses a GET and malformed bodies', async () => {
    expect((await worker.fetch(new Request('https://reader.test/api/messages'))).status).toBeGreaterThanOrEqual(400)
    expect((await submit('not base64!')).status).toBe(400)
  })
})
