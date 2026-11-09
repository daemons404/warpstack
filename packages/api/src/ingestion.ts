import { DurableObject } from 'cloudflare:workers'
import { parseShardIndex, type ShardIndex } from '@warpstack/protocol'
import { D1Sql } from './adapters/d1.ts'
import { SqlIndexWriter } from './adapters/index-writer.ts'
import { snapchainOf } from './adapters/snapchain-pool.ts'
import { systemClock } from './adapters/clock.ts'
import { parseConfig } from './config.ts'
import { API_LIMITS } from './core/limits.ts'
import type { Env } from './env.ts'
import { deliverPending } from './deliveries.ts'
import { ingestTick, type TickMemory, type TickResult } from './ingest.ts'
import type { UserApi } from './user-object.ts'

type Status = { shard: ShardIndex; last?: TickResult; lastTickAt?: number; errors: number; lastError?: string }

/**
 * One Durable Object per data shard (ADR 12). It polls on an alarm about once a second;
 * D1's cursor row is the truth, and this object only schedules. The alarm never stops
 * itself: every error is caught and recorded, and the next alarm is always set, because
 * Cloudflare retries a throwing alarm only six times.
 */
export class IngestionObject extends DurableObject<Env> {
  /** Lives as long as this instance; see `TickMemory`. */
  private readonly memory: TickMemory = {}

  /** Starts polling if it isn't already. The watchdog cron calls this every minute. */
  async ensure(shard: number): Promise<void> {
    const s = parseShardIndex(shard)
    if (!s.ok) throw new Error(`not a data shard: ${shard}`)
    await this.ctx.storage.put('shard', s.value)
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now())
  }

  async status(): Promise<Status | undefined> {
    return this.ctx.storage.get<Status>('status')
  }

  override async alarm(): Promise<void> {
    const shard = await this.ctx.storage.get<ShardIndex>('shard')
    if (!shard) return
    const prev = (await this.ctx.storage.get<Status>('status')) ?? { shard, errors: 0 }
    let delay: number = API_LIMITS.POLL_MS
    try {
      const config = parseConfig(this.env)
      const result = await ingestTick({
        snapchain: snapchainOf(config.snapchain),
        writer: new SqlIndexWriter(new D1Sql(this.env.DB), () => Date.now()),
        clock: systemClock,
      }, shard, { backfillHours: config.backfillHours, memory: this.memory })
      delay = result.status === 'behind' || result.status === 'restarted' ? API_LIMITS.BEHIND_MS
        : result.status === 'unreachable' || result.status === 'contended' ? API_LIMITS.BACKOFF_MS : API_LIMITS.POLL_MS
      await this.ctx.storage.put('status', {
        shard, last: result, lastTickAt: Date.now(),
        errors: result.status === 'unreachable' || result.status === 'contended' ? prev.errors + 1 : 0,
        lastError: result.status === 'unreachable' || result.status === 'contended' ? result.detail : prev.lastError,
      } satisfies Status)
      if (result.status === 'unreachable') console.warn(`ingest shard ${shard}: node unreachable: ${result.detail}`)
      // Members' own steps from the pages just committed, to their user objects.
      const users = (fid: number) => this.env.USER.get(this.env.USER.idFromName(String(fid))) as unknown as UserApi
      await deliverPending(new D1Sql(this.env.DB), users, shard)
    } catch (e) {
      delay = API_LIMITS.BACKOFF_MS
      console.error(`ingest shard ${shard}: ${String(e)}`)
      await this.ctx.storage.put('status', { ...prev, lastTickAt: Date.now(), errors: prev.errors + 1, lastError: String(e) } satisfies Status)
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + delay)
    }
  }
}
