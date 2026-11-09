import { D1Sql } from './adapters/d1.ts'
import { FarcasterChannelRegistry, SeededChannelRegistry } from './adapters/channel-registry.ts'
import { IndexMaintenance } from './adapters/index-maintenance.ts'
import { IndexReader } from './adapters/index-reader.ts'
import { systemClock } from './adapters/clock.ts'
import { ensureIngestion } from './app.ts'
import { parseConfig } from './config.ts'
import { API_LIMITS } from './core/limits.ts'
import type { Env } from './env.ts'

/** Cron schedules, matched against the `crons` list in wrangler config. */
export const CRONS = { watchdog: '* * * * *', daily: '17 3 * * *' } as const

export const scheduled = async (controller: ScheduledController, env: Env): Promise<void> => {
  // The watchdog makes sure each ingestion object has an alarm set, so ingestion recovers
  // from any outage without a user request.
  await ensureIngestion(env)
  const db = new D1Sql(env.DB)
  const maintenance = new IndexMaintenance(db)
  const empty = (await new IndexReader(db).channelCount()) === 0
  if (controller.cron === CRONS.daily || empty) await refreshChannels(env, maintenance)
  if (controller.cron === CRONS.daily) {
    await prune(maintenance, parseConfig(env).retentionDays)
    await maintenance.pruneFollowing(systemClock.now() - API_LIMITS.FOLLOWING_TTL)
  }
}

const refreshChannels = async (env: Env, maintenance: IndexMaintenance) => {
  const config = parseConfig(env)
  const primary = config.channelRegistry === 'farcaster' ? new FarcasterChannelRegistry() : new SeededChannelRegistry()
  let rows = await primary.list()
  if (!rows.ok) {
    console.warn(`channel registry unavailable, using the seeded list: ${rows.error.detail}`)
    rows = await new SeededChannelRegistry().list()
  }
  if (rows.ok) await maintenance.putChannels(rows.value, systemClock.now())
}

const prune = async (maintenance: IndexMaintenance, retentionDays: number) => {
  const before = systemClock.now() - retentionDays * 86_400
  for (let i = 0; i < API_LIMITS.PRUNE_BATCHES_PER_RUN; i++) {
    const n = await maintenance.prune(before, API_LIMITS.PRUNE_BATCH)
    // Count rows outnumber casts, since reactions also target older casts: loop until every table is done.
    if (Math.max(n.casts, n.recasts, n.counts) < API_LIMITS.PRUNE_BATCH) break
  }
}
