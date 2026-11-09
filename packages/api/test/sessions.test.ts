import { ed25519 } from '@noble/curves/ed25519.js'
import { fromHex, sessionPreimage, toHex, type EventId, type Fid, type ShardIndex, type Timestamp } from '@warpstack/protocol'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { HmacMac } from '../src/adapters/hmac.ts'
import { SqlIndexWriter } from '../src/adapters/index-writer.ts'
import { FakeSnapchain } from '../src/adapters/snapchain-fake.ts'
import { foldPage } from '../src/core/fold.ts'
import { bearer, makeChallenge, makeToken, openChallenge, SESSION_TTL, SIGNER_RECHECK, SIGNER_STALE_MAX, tokenFid } from '../src/core/session.ts'
import { deliverPending } from '../src/deliveries.ts'
import type { SyncSql } from '../src/ports.ts'
import type { Admission } from '../src/config.ts'
import { Sessions } from '../src/sessions.ts'
import type { UserApi } from '../src/user-object.ts'
import { BACKFILL_MAX, readSignerCheck, UserStore } from '../src/user-store.ts'
import { castAdd, follow, merge, reaction, remove } from './build.ts'
import { MemorySql } from './sqlite.ts'

// Sessions, the user object's store and member deliveries, on the fake
// node and node:sqlite. The Miniflare suite runs the routes against real Durable Objects.

const T = 1_793_000_000
const ORIGIN = 'https://warpstack.test'
const FID = 1234 as Fid
const SEED = new Uint8Array(32).fill(9)
const KEY = toHex(ed25519.getPublicKey(SEED))
const CUSTODY = `0x${'c'.repeat(40)}`
const mac = new HmacMac('s'.repeat(32))

const memorySync = (): SyncSql => {
  const db = new DatabaseSync(':memory:')
  return {
    all: <R>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...(params as never[])) as R[],
    run: (sql: string, ...params: unknown[]) => { db.prepare(sql).run(...(params as never[])) },
    transaction: <R>(fn: () => R) => {
      db.exec('BEGIN')
      try {
        const r = fn()
        db.exec('COMMIT')
        return r
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  }
}

/** A user object in memory, with the Durable Object's RPC surface. */
const fakeUser = (store: UserStore, snap: FakeSnapchain, now: () => number): UserApi => ({
  openSession: async (_fid, s) => {
    const r = store.openSession(s)
    return r.ok ? { ok: true, expiresAt: r.expiresAt } : r
  },
  authenticate: async (_fid, h) => store.authenticate(h, now(), () => readSignerCheck(snap, store.fid, now())),
  endSession: async (_fid, h) => store.endSession(h),
  apply: async (_fid, d) => store.apply(d),
  status: async (_fid, h) => store.status(h),
  reactions: async () => store.reactions(),
  links: async () => store.links(),
  inbox: async (_fid, before, limit) => store.inbox(before, limit),
  markSeen: async (_fid, upTo) => store.markSeen(upTo),
  unseen: async () => store.unseen(),
  inboxFilled: async () => store.inboxFilled(),
  fillInbox: async (_fid, notes) => store.fillInbox(notes),
}) as UserApi

const setup = (admission: Admission = { public: false, allowed: new Set([FID]) }) => {
  let now = T
  let n = 0
  const snap = new FakeSnapchain()
  snap.signersByFid.set(FID, { keys: [{ key: KEY, source: 'gasless', scopes: [1] }], userNonce: 1, requesterNonces: new Map() })
  snap.custody.set(FID, CUSTODY)
  const db = new MemorySql()
  const stores = new Map<number, UserStore>()
  const store = (fid: number) => stores.get(fid) ?? stores.set(fid, new UserStore(memorySync(), fid as Fid)).get(fid)!
  const sessions = new Sessions({
    mac, clock: { now: () => now as Timestamp }, snapchain: snap, db,
    random: { bytes: k => new Uint8Array(k).fill(++n % 256) },
    users: fid => fakeUser(store(fid), snap, () => now),
    origin: ORIGIN, acceptKeysFrom: { kind: 'any' }, admission, readOnly: false,
  })
  const signIn = async (o: { origin?: string; seed?: Uint8Array } = {}) => {
    const c = await sessions.challenge(FID, KEY)
    const pre = sessionPreimage(o.origin ?? ORIGIN, fromHex(c.nonce, 32)!)
    if (!pre.ok) throw new Error(pre.error)
    const signature = toHex(ed25519.sign(pre.value, o.seed ?? SEED))
    return { c, signature, r: await sessions.verify({ fid: FID, key: KEY, challenge: c.challenge, signature, device: 'device-one' }) }
  }
  return { snap, db, sessions, store, signIn, advance: (s: number) => { now += s }, now: () => now }
}

const APP = 9_999

describe('challenges and tokens', () => {
  it('open only for the FID, key and origin they were made for, until they expire', async () => {
    const c = await makeChallenge(mac, { fid: FID, key: KEY, origin: ORIGIN, nonce: new Uint8Array(32).fill(1), now: T })
    expect((await openChallenge(mac, { challenge: c.challenge, fid: FID, key: KEY, origin: ORIGIN, now: T })).ok).toBe(true)
    expect(await openChallenge(mac, { challenge: c.challenge, fid: 2, key: KEY, origin: ORIGIN, now: T })).toEqual({ ok: false, error: 'forged' })
    expect(await openChallenge(mac, { challenge: c.challenge, fid: FID, key: `0x${'1'.repeat(64)}`, origin: ORIGIN, now: T })).toEqual({ ok: false, error: 'forged' })
    expect(await openChallenge(mac, { challenge: c.challenge, fid: FID, key: KEY, origin: 'https://other.test', now: T })).toEqual({ ok: false, error: 'forged' })
    expect(await openChallenge(mac, { challenge: c.challenge, fid: FID, key: KEY, origin: ORIGIN, now: c.expiresAt })).toEqual({ ok: false, error: 'expired' })
    expect(await openChallenge(new HmacMac('x'.repeat(32)), { challenge: c.challenge, fid: FID, key: KEY, origin: ORIGIN, now: T })).toEqual({ ok: false, error: 'forged' })
    expect((await openChallenge(mac, { challenge: 'a.b', fid: FID, key: KEY, origin: ORIGIN, now: T })).ok).toBe(false)
  })

  it('name their FID only with a valid MAC', async () => {
    const t = await makeToken(mac, FID, new Uint8Array(32).fill(4))
    expect(await tokenFid(mac, t)).toBe(FID)
    expect(await tokenFid(mac, t.replace(/^1234/, '1726'))).toBeNull()
    expect(await tokenFid(new HmacMac('x'.repeat(32)), t)).toBeNull()
    expect(await tokenFid(mac, 'garbage')).toBeNull()
    expect(bearer(`Bearer ${t}`)).toBe(t)
    expect(bearer(`Basic ${t}`)).toBeNull()
  })
})

describe('sessions', () => {
  it('opens a session for an active key, once per challenge, and makes the FID a member', async () => {
    const s = setup()
    const { c, signature, r } = await s.signIn()
    expect(r.ok && r.value.expiresAt).toBe(T + SESSION_TTL)
    expect(await s.db.all('SELECT fid FROM members')).toEqual([{ fid: FID }])
    // The same challenge again: the object has spent its nonce.
    expect(await s.sessions.verify({ fid: FID, key: KEY, challenge: c.challenge, signature })).toEqual({ ok: false, error: { kind: 'challenge' } })
    const auth = await s.sessions.authenticate(r.ok ? r.value.token : null)
    expect(auth.ok && auth.value.fid).toBe(FID)
  })

  it('refuses a signature for another origin, another key, or a key the node does not list', async () => {
    const s = setup()
    expect((await s.signIn({ origin: 'https://other.test' })).r).toEqual({ ok: false, error: { kind: 'signature' } })
    expect((await s.signIn({ seed: new Uint8Array(32).fill(1) })).r).toEqual({ ok: false, error: { kind: 'signature' } })
    s.snap.signersByFid.set(FID, { keys: [], userNonce: 1, requestFids: new Map() } as never)
    expect((await s.signIn()).r).toEqual({ ok: false, error: { kind: 'key_inactive' } })
    expect(await s.db.all('SELECT fid FROM members')).toEqual([])
  })

  it('refuses a forged or expired token before the user object, and ends sessions after a day', async () => {
    const s = setup()
    const { r } = await s.signIn()
    const token = r.ok ? r.value.token : ''
    expect(await s.sessions.authenticate(null)).toEqual({ ok: false, error: { kind: 'session' } })
    expect(await s.sessions.authenticate(token.slice(0, -2) + 'AA')).toEqual({ ok: false, error: { kind: 'session' } })
    s.snap.calls = 0
    s.advance(SESSION_TTL)
    expect(await s.sessions.authenticate(token)).toEqual({ ok: false, error: { kind: 'session' } })
  })

  it('ends the session within SIGNER_RECHECK of the key being removed or the custody moving', async () => {
    const s = setup()
    const token = (await s.signIn()).r
    const t = token.ok ? token.value.token : ''
    s.snap.signersByFid.set(FID, { keys: [], userNonce: 1, requesterNonces: new Map() })
    s.advance(SIGNER_RECHECK)
    expect((await s.sessions.authenticate(t)).ok).toBe(true)
    s.advance(1)
    expect(await s.sessions.authenticate(t)).toEqual({ ok: false, error: { kind: 'session' } })

    const s2 = setup()
    const t2 = (await s2.signIn()).r
    s2.snap.custody.set(FID, `0x${'d'.repeat(40)}`)
    s2.advance(SIGNER_RECHECK + 1)
    expect(await s2.sessions.authenticate(t2.ok ? t2.value.token : '')).toEqual({ ok: false, error: { kind: 'session' } })
  })

  it('keeps working for SIGNER_STALE_MAX when no node answers, then fails as upstream', async () => {
    const s = setup()
    const r = (await s.signIn()).r
    const t = r.ok ? r.value.token : ''
    s.snap.down = true
    s.advance(SIGNER_RECHECK + 1)
    expect((await s.sessions.authenticate(t)).ok).toBe(true)
    s.advance(SIGNER_STALE_MAX)
    expect(await s.sessions.authenticate(t)).toMatchObject({ ok: false, error: { kind: 'upstream' } })
    s.snap.down = false
    expect((await s.sessions.authenticate(t)).ok).toBe(true)
  })

  it('lets a recheck judge only the sessions it saw, so a session opened meanwhile survives', async () => {
    const store = new UserStore(memorySync(), FID)
    const open = (tokenHash: string, appKey: string, now: number) => store.openSession({
      nonce: tokenHash, nonceExpires: now + 60, tokenHash, appKey, device: 'd', custody: CUSTODY, now,
    })
    expect(open('old', KEY, T).ok).toBe(true)
    const later = T + SIGNER_RECHECK + 1
    let answer: (c: Awaited<ReturnType<typeof readSignerCheck>>) => void = () => {}
    const slow = new Promise<Awaited<ReturnType<typeof readSignerCheck>>>(r => { answer = r })
    const auth = store.authenticate('old', later, () => slow)
    // A new key was added on chain and signed in while the recheck's read was in flight.
    const NEW = `0x${'e'.repeat(64)}`
    expect(open('new', NEW, later).ok).toBe(true)
    answer({ keys: new Set([KEY]), custody: CUSTODY, requestFids: new Map() })
    expect((await auth).ok).toBe(true)
    expect((await store.authenticate('new', later, async () => null)).ok).toBe(true)
  })

  it('ends one session and leaves the others', async () => {
    const s = setup()
    const a = (await s.signIn()).r
    const b = (await s.signIn()).r
    if (!a.ok || !b.ok) throw new Error('sign-in failed')
    const auth = await s.sessions.authenticate(a.value.token)
    if (!auth.ok) throw new Error('auth failed')
    await auth.value.user.endSession(FID, auth.value.tokenHash)
    expect((await s.sessions.authenticate(a.value.token)).ok).toBe(false)
    expect((await s.sessions.authenticate(b.value.token)).ok).toBe(true)
  })
})

describe('who may use a private deployment', () => {
  it('admits only allowed FIDs: signing in proves who you are, not that you are invited', async () => {
    const { signIn, db } = setup({ public: false, allowed: new Set([42]) })
    expect((await signIn()).r).toEqual({ ok: false, error: { kind: 'not_accepted' } })
    expect(await db.all('SELECT * FROM members')).toEqual([])
  })

  it('admits keys the app FID requested, with APP_FID', async () => {
    const t = setup({ public: false, allowed: new Set(), appFid: APP })
    expect((await t.signIn()).r).toEqual({ ok: false, error: { kind: 'not_accepted' } })
    const app = setup({ public: false, allowed: new Set(), appFid: APP })
    app.snap.signersByFid.set(FID, { keys: [{ key: KEY, source: 'gasless', scopes: [1], requestFid: APP }], userNonce: 1, requesterNonces: new Map() })
    expect((await app.signIn()).r.ok).toBe(true)
  })

  it('with an app FID, ends a listed FID\'s sessions once it is taken off the list, unless the app requested its key', async () => {
    const allowed = new Set([FID])
    const listed = setup({ public: false, allowed, appFid: APP })
    const r = (await listed.signIn()).r
    if (!r.ok) throw new Error('sign-in failed')
    expect((await listed.sessions.authenticate(r.value.token)).ok).toBe(true)
    allowed.delete(FID)
    expect(await listed.sessions.authenticate(r.value.token)).toEqual({ ok: false, error: { kind: 'session' } })

    const app = setup({ public: false, allowed: new Set(), appFid: APP })
    app.snap.signersByFid.set(FID, { keys: [{ key: KEY, source: 'gasless', scopes: [1], requestFid: APP }], userNonce: 1, requesterNonces: new Map() })
    const a = (await app.signIn()).r
    if (!a.ok) throw new Error('sign-in failed')
    expect((await app.sessions.authenticate(a.value.token)).ok).toBe(true)
  })

  it('admits anyone when public', async () => {
    expect((await setup({ public: true, allowed: new Set() }).signIn()).r.ok).toBe(true)
  })

  it('ends a FID\'s sessions as soon as it is taken off the list', async () => {
    const allowed = new Set([FID])
    const { signIn, sessions } = setup({ public: false, allowed })
    const r = (await signIn()).r
    if (!r.ok) throw new Error('sign-in failed')
    expect((await sessions.authenticate(r.value.token)).ok).toBe(true)
    allowed.delete(FID)
    expect(await sessions.authenticate(r.value.token)).toEqual({ ok: false, error: { kind: 'session' } })
  })
})

describe('member deliveries and the own history', () => {
  const ingest = async (db: MemorySql, events: Parameters<typeof foldPage>[0]) => {
    const writer = new SqlIndexWriter(db, () => T * 1_000)
    const cur = (await writer.cursor(1 as ShardIndex)) ?? { shard: 1 as ShardIndex, lastEventId: 0 as EventId, lastBlockTs: T as Timestamp }
    if (!(await writer.cursor(1 as ShardIndex))) await writer.resetCursor(cur)
    const f = foldPage(events, cur.lastEventId)
    const r = await writer.applyPage(cur, { shard: 1 as ShardIndex, lastEventId: f.lastEventId, lastBlockTs: cur.lastBlockTs }, f.ops)
    if (!r.ok) throw new Error('cursor moved')
  }

  it('queues only members\' steps, applies them once, in order, after the backfill', async () => {
    const s = setup()
    const before = castAdd({ fid: FID, ts: T - 100, text: 'before joining' })
    s.snap.add(before)
    await s.signIn()
    const store = s.store(FID)
    expect(store.history()).toBe('backfilling')

    const mine = castAdd({ fid: FID, ts: T + 1, text: 'mine' })
    const like = reaction({ fid: FID, ts: T + 2, kind: 'like', target: { fid: 3, hash: `0x${'3'.repeat(40)}` } })
    const theirs = castAdd({ fid: 2, ts: T + 3 })
    await ingest(s.db, [merge(mine), merge(like), merge(theirs), merge(follow({ fid: FID, ts: T + 4, target: 77 }))])
    expect((await s.db.all<{ fid: number }>('SELECT DISTINCT fid FROM deliveries')).map(r => r.fid)).toEqual([FID])

    const users = (fid: number) => fakeUser(s.store(fid), s.snap, s.now)
    // The backfill hasn't run: the steps wait in D1.
    expect(await deliverPending(s.db, users, 1)).toEqual({ delivered: 0, waiting: 1, failed: 0 })
    expect(await store.backfill(s.snap)).toBe('complete')
    expect(await deliverPending(s.db, users, 1)).toEqual({ delivered: 3, waiting: 0, failed: 0 })
    expect(await s.db.all('SELECT * FROM deliveries')).toEqual([])

    expect(store.status([mine.hash, like.hash, before.hash, theirs.hash])).toEqual({
      [mine.hash]: 'merged', [like.hash]: 'merged', [before.hash]: 'unknown', [theirs.hash]: 'unknown',
    })
    expect(store.reactions()).toEqual({ likes: [`0x${'3'.repeat(40)}`], recasts: [], history: 'complete' })
    expect(store.links()).toEqual({ following: [77], blocking: [], history: 'complete' })

    // A repeated delivery changes nothing; a removal takes away exactly what it names.
    expect(store.apply([{ shard: 1, event_id: 1, seq: 0, payload: JSON.stringify({ op: 'remove', msg: { hash: like.hash, fid: FID, ts: T, kind: 'reaction' } }) }])).toEqual({ ok: true })
    expect(store.reactions().likes).toHaveLength(1)
    await ingest(s.db, [remove(like, T + 10)])
    await deliverPending(s.db, users, 1)
    expect(store.reactions().likes).toEqual([])
  })

  it('records a gap when the history is longer than the backfill reads', async () => {
    const s = setup()
    for (let i = 0; i < BACKFILL_MAX + 1; i++) s.snap.add(castAdd({ fid: FID, ts: T - i }))
    await s.signIn()
    expect(await s.store(FID).backfill(s.snap)).toBe('gap')
    expect(s.store(FID).links().history).toBe('gap')
  })

  it('stores nothing and retries when the node fails mid-backfill', async () => {
    const s = setup()
    await s.signIn()
    const failing = Object.assign(Object.create(s.snap), {
      reactionsByFid: async () => ({ ok: false, error: { kind: 'unavailable', detail: 'down' } }),
    }) as FakeSnapchain
    expect(await s.store(FID).backfill(failing)).toBe('retry')
    expect(s.store(FID).history()).toBe('backfilling')
  })
})
