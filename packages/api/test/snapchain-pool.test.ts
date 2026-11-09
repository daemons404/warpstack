import { err, ok, type Fid } from '@warpstack/protocol'
import { describe, expect, it } from 'vitest'
import { HttpSnapchain } from '../src/adapters/snapchain-http.ts'
import { PooledSnapchain, snapchainOf } from '../src/adapters/snapchain-pool.ts'
import { parseConfig } from '../src/config.ts'
import type { Env } from '../src/env.ts'
import type { Snapchain } from '../src/ports.ts'

// The pool of Snapchain nodes: failover when a node is down, not
// when it answers; a breaker per node; writes to two nodes.

type Answer = 'up' | 'down' | 'refuse'

/** A node whose custody read and submit answer as `state()` says, counting calls. */
const node = (state: () => Answer) => {
  const calls = { custody: 0, submit: 0 }
  const api = {
    custodyOf: async () => {
      calls.custody++
      const s = state()
      return s === 'up' ? ok('0xabc') : err(s === 'down' ? { kind: 'unavailable' as const, detail: 'timeout' } : { kind: 'bad_response' as const, detail: 'nope' })
    },
    submitMessage: async () => {
      calls.submit++
      const s = state()
      return s === 'up' ? ok({ hash: '0x1' }) : err(s === 'down' ? { kind: 'unavailable' as const, detail: 'timeout' } : { kind: 'rejected' as const, detail: 'duplicate' })
    },
  } as unknown as Snapchain
  return { api, calls }
}

const FID = 1 as Fid

describe('the Snapchain pool', () => {
  it('uses the first node, and fails over only when a node is unavailable', async () => {
    let a: Answer = 'up'
    const n1 = node(() => a), n2 = node(() => 'up')
    const pool = new PooledSnapchain([{ name: 'a', api: n1.api }, { name: 'b', api: n2.api }], () => 0, new Map())
    expect(await pool.custodyOf(FID)).toEqual(ok('0xabc'))
    expect([n1.calls.custody, n2.calls.custody]).toEqual([1, 0])
    a = 'down'
    expect(await pool.custodyOf(FID)).toEqual(ok('0xabc'))
    expect([n1.calls.custody, n2.calls.custody]).toEqual([2, 1])
    // A node that answers with an error isn't failed over: another would answer the same.
    a = 'refuse'
    expect(await pool.custodyOf(FID)).toMatchObject({ ok: false, error: { kind: 'bad_response' } })
    expect(n2.calls.custody).toBe(1)
  })

  it('skips a node after three failures in a row for 30 seconds, then tries it again', async () => {
    let now = 0
    let a: Answer = 'down'
    const n1 = node(() => a), n2 = node(() => 'up')
    const pool = new PooledSnapchain([{ name: 'a', api: n1.api }, { name: 'b', api: n2.api }], () => now, new Map())
    for (let i = 0; i < 3; i++) await pool.custodyOf(FID)
    expect(n1.calls.custody).toBe(3)
    await pool.custodyOf(FID)
    expect(n1.calls.custody).toBe(3)
    now += 30_001
    a = 'up'
    await pool.custodyOf(FID)
    expect(n1.calls.custody).toBe(4)
  })

  it('still asks every node when all of them are down', async () => {
    const n1 = node(() => 'down'), n2 = node(() => 'down')
    const pool = new PooledSnapchain([{ name: 'a', api: n1.api }, { name: 'b', api: n2.api }], () => 0, new Map())
    for (let i = 0; i < 4; i++) expect(await pool.custodyOf(FID)).toMatchObject({ ok: false, error: { kind: 'unavailable', detail: expect.stringContaining('b:') } })
    expect([n1.calls.custody, n2.calls.custody]).toEqual([4, 4])
  })

  it('submits to two nodes, and takes either one\'s acceptance', async () => {
    const n1 = node(() => 'up'), n2 = node(() => 'refuse'), n3 = node(() => 'up')
    const pool = new PooledSnapchain([{ name: 'a', api: n1.api }, { name: 'b', api: n2.api }, { name: 'c', api: n3.api }], () => 0, new Map())
    expect(await pool.submitMessage(new Uint8Array(1))).toEqual(ok({ hash: '0x1' }))
    expect([n1.calls.submit, n2.calls.submit, n3.calls.submit]).toEqual([1, 1, 0])
  })

  it('reports a refusal over "unavailable" when no node accepts', async () => {
    const n1 = node(() => 'down'), n2 = node(() => 'refuse')
    const pool = new PooledSnapchain([{ name: 'a', api: n1.api }, { name: 'b', api: n2.api }], () => 0, new Map())
    expect(await pool.submitMessage(new Uint8Array(1))).toMatchObject({ ok: false, error: { kind: 'rejected', detail: 'duplicate' } })
  })

  it('is one plain node when only one is configured', () => {
    expect(snapchainOf({ nodes: ['https://snap.example:3381'] })).toBeInstanceOf(HttpSnapchain)
    expect(snapchainOf({ nodes: ['https://a.example', 'https://b.example'] })).toBeInstanceOf(PooledSnapchain)
  })
})

describe('config', () => {
  const env = (more: Partial<Env> = {}) => ({
    SNAPCHAIN_URL: 'https://snap.farcaster.xyz:3381',
    CURSOR_MAC_KEY: 'c'.repeat(32),
    SESSION_MAC_KEY: 's'.repeat(32),
    CANONICAL_ORIGIN: 'https://warpstack.example',
    ACCESS: 'public',
    ...more,
  }) as Env

  it('reads one node or a pool from SNAPCHAIN_URL', () => {
    expect(parseConfig(env()).snapchain.nodes).toEqual(['https://snap.farcaster.xyz:3381'])
    expect(parseConfig(env({ SNAPCHAIN_URL: 'https://a.example, https://b.example' })).snapchain.nodes).toEqual(['https://a.example', 'https://b.example'])
    expect(() => parseConfig(env({ SNAPCHAIN_URL: 'https://a.example, ftp://b' }))).toThrow(/SNAPCHAIN_URL/)
    expect(() => parseConfig(env({ SNAPCHAIN_URL: '' }))).toThrow(/SNAPCHAIN_URL/)
  })

  it('keeps 28 days of casts unless RETENTION_DAYS says otherwise, within D1\'s bound', () => {
    expect(parseConfig(env()).retentionDays).toBe(28)
    expect(parseConfig(env({ RETENTION_DAYS: '14' })).retentionDays).toBe(14)
    expect(() => parseConfig(env({ RETENTION_DAYS: '365' }))).toThrow(/RETENTION_DAYS/)
  })
})
