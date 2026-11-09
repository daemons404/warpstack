import type { Sql } from './ports.ts'
import type { Delivery } from './user-store.ts'
import type { UserApi } from './user-object.ts'

// The delivery loop: after each ingestion tick, hand each member's
// queued own-history steps to their user object in event order, and delete them only once the
// object has applied them. The object skips anything at or below its own mark, so a delivery
// repeated after a crash changes nothing. Each member is handled on its own: a slow, failing
// or backfilling object only delays its own steps.

/** Members handled per tick, and steps per member per call. */
export const DELIVERY_LIMITS = { MEMBERS: 25, STEPS: 200 } as const

export type DeliveryResult = { delivered: number; waiting: number; failed: number }

export const deliverPending = async (db: Sql, users: (fid: number) => UserApi, shard: number): Promise<DeliveryResult> => {
  const out: DeliveryResult = { delivered: 0, waiting: 0, failed: 0 }
  const members = await db.all<{ fid: number }>('SELECT DISTINCT fid FROM deliveries WHERE shard = ?1 LIMIT ?2', [shard, DELIVERY_LIMITS.MEMBERS])
  await Promise.all(members.map(async ({ fid }) => {
    const rows = await db.all<Delivery>(
      'SELECT shard, event_id, seq, payload FROM deliveries WHERE fid = ?1 AND shard = ?2 ORDER BY event_id, seq LIMIT ?3',
      [fid, shard, DELIVERY_LIMITS.STEPS])
    const last = rows.at(-1)
    if (!last) return
    try {
      const r = await users(fid).apply(fid, rows)
      if (!r.ok) {
        out.waiting++
        return
      }
      await db.batch([{
        sql: 'DELETE FROM deliveries WHERE fid = ?1 AND shard = ?2 AND (event_id < ?3 OR (event_id = ?3 AND seq <= ?4))',
        params: [fid, shard, last.event_id, last.seq],
      }])
      out.delivered += rows.length
    } catch (e) {
      out.failed++
      console.error(`deliver to ${fid}: ${String(e)}`)
    }
  }))
  return out
}
