import { DurableObject } from 'cloudflare:workers'
import type { Fid } from '@warpstack/protocol'
import { snapchainOf } from './adapters/snapchain-pool.ts'
import { systemClock } from './adapters/clock.ts'
import { parseConfig } from './config.ts'
import type { Env } from './env.ts'
import type { SyncSql } from './ports.ts'
import type { Note } from './core/inbound.ts'
import { readSignerCheck, UserStore, type AuthResult, type Delivery, type History, type InboxGroup, type SessionOpen } from './user-store.ts'

// One Durable Object per FID, named by the FID. Only the session
// middleware, `session.verify` and the ingestion object's delivery loop reach it, and only
// after their own checks: no unauthenticated request does.

const RETRY_MS = 60_000

const durableSql = (ctx: DurableObjectState): SyncSql => ({
  all: <T>(sql: string, ...params: unknown[]) => ctx.storage.sql.exec(sql, ...params).toArray() as T[],
  run: (sql: string, ...params: unknown[]) => { ctx.storage.sql.exec(sql, ...params) },
  transaction: <T>(fn: () => T) => ctx.storage.transactionSync(fn),
})

export class UserObject extends DurableObject<Env> {
  private cached: UserStore | null = null

  /** The store for this object's FID; every call names it, and it can never change. */
  private store(fid: number): UserStore {
    if (this.cached) {
      if (this.cached.fid !== fid) throw new Error('a user object serves one FID')
      return this.cached
    }
    const sql = durableSql(this.ctx)
    sql.run('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
    const [owner] = sql.all<{ v: string }>("SELECT v FROM meta WHERE k = 'fid'")
    if (owner && Number(owner.v) !== fid) throw new Error('a user object serves one FID')
    if (!owner) sql.run("INSERT INTO meta (k, v) VALUES ('fid', ?)", String(fid))
    this.cached = new UserStore(sql, fid as Fid)
    return this.cached
  }

  private snapchain() {
    return snapchainOf(parseConfig(this.env).snapchain)
  }

  /** Wakes for the next session or challenge expiry, or sooner. */
  private async wakeBy(at: number) {
    const cur = await this.ctx.storage.getAlarm()
    if (cur === null || cur > at) await this.ctx.storage.setAlarm(at)
  }

  private async scheduleDeadline(store: UserStore) {
    const t = store.nextDeadline()
    if (t !== null) await this.wakeBy(t * 1000)
  }

  async openSession(fid: number, s: SessionOpen): Promise<{ ok: true; expiresAt: number } | { ok: false }> {
    const store = this.store(fid)
    const r = store.openSession(s)
    if (!r.ok) return r
    if (r.backfill) await this.wakeBy(Date.now())
    else await this.scheduleDeadline(store)
    return { ok: true, expiresAt: r.expiresAt }
  }

  async authenticate(fid: number, tokenHash: string): Promise<AuthResult> {
    const store = this.store(fid)
    const now = systemClock.now()
    return store.authenticate(tokenHash, now, () => readSignerCheck(this.snapchain(), store.fid, now))
  }

  async endSession(fid: number, tokenHash: string): Promise<void> {
    this.store(fid).endSession(tokenHash)
  }

  async apply(fid: number, deliveries: Delivery[]): Promise<{ ok: true } | { ok: false; reason: 'backfilling' }> {
    return this.store(fid).apply(deliveries)
  }

  async status(fid: number, hashes: string[]): Promise<Record<string, 'merged' | 'unknown'>> {
    return this.store(fid).status(hashes)
  }

  async reactions(fid: number) {
    return this.store(fid).reactions()
  }

  async links(fid: number) {
    return this.store(fid).links()
  }

  async inbox(fid: number, before: { ts: number; key: string } | null, limit: number): Promise<InboxGroup[]> {
    return this.store(fid).inbox(before, limit)
  }

  async markSeen(fid: number, upTo: number): Promise<void> {
    this.store(fid).markSeen(upTo)
  }

  async unseen(fid: number): Promise<number> {
    return this.store(fid).unseen()
  }

  async inboxFilled(fid: number): Promise<boolean> {
    return this.store(fid).inboxFilled()
  }

  async fillInbox(fid: number, notes: Note[]): Promise<void> {
    this.store(fid).fillInbox(notes)
  }

  override async alarm(): Promise<void> {
    const [owner] = durableSql(this.ctx).all<{ v: string }>("SELECT v FROM meta WHERE k = 'fid'")
    if (!owner) return
    const store = this.store(Number(owner.v))
    store.prune(systemClock.now())
    let backfill: History | 'retry' | null = null
    if (store.history() === 'backfilling') {
      try {
        backfill = await store.backfill(this.snapchain())
      } catch (e) {
        console.error(`user ${owner.v}: backfill: ${String(e)}`)
        backfill = 'retry'
      }
    }
    if (backfill === 'retry') await this.ctx.storage.setAlarm(Date.now() + RETRY_MS)
    else await this.scheduleDeadline(store)
  }
}

/** What callers can ask of a user object: the Durable Object's RPC surface, or a fake in tests. */
export type UserApi = Pick<UserObject, 'openSession' | 'authenticate' | 'endSession' | 'apply' | 'status' | 'reactions' | 'links' | 'inbox' | 'markSeen' | 'unseen' | 'inboxFilled' | 'fillInbox'>
