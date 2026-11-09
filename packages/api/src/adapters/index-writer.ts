import { ok, err, type ShardIndex, type EventId, type Timestamp } from '@warpstack/protocol'
import type { IndexOps, UserField } from '../core/rows.ts'
import type { ApplyResult, CastIndexWriter, Cursor, Sql, SqlStatement } from '../ports.ts'

// The cast index's write side, on any SQLite behind the `Sql` port. Each page becomes one
// batch: the guarded cursor update first, then the page's rows packed into JSON parameters
// (D1 allows 100 bound parameters per statement), all in one transaction.

const USER_COLUMNS: readonly UserField[] = ['username', 'display', 'pfp', 'bio', 'url', 'location', 'banner', 'primary_addr']

type CursorRow = { shard: number; last_event_id: number; last_block_ts: number }

export class SqlIndexWriter implements CastIndexWriter {
  /** `nowMs` stamps `rev`; it comes from the injected clock. */
  constructor(private readonly db: Sql, private readonly nowMs: () => number) {}

  async cursor(shard: ShardIndex): Promise<Cursor | null> {
    const [row] = await this.db.all<CursorRow>('SELECT shard, last_event_id, last_block_ts FROM ingest_cursor WHERE shard = ?', [shard])
    return row ? { shard, lastEventId: row.last_event_id as EventId, lastBlockTs: row.last_block_ts as Timestamp } : null
  }

  async resetCursor(c: Cursor): Promise<void> {
    await this.db.batch([bumpRev(this.nowMs()), {
      sql: `INSERT INTO ingest_cursor (shard, last_event_id, prev_event_id, last_block_ts, covered_since)
            VALUES (?1, ?2, ?2, ?3, ?3)
            ON CONFLICT (shard) DO UPDATE SET last_event_id = ?2, prev_event_id = ?2, last_block_ts = ?3, covered_since = ?3`,
      params: [c.shard, c.lastEventId, c.lastBlockTs],
    }])
  }

  async applyPage(expected: Cursor, next: Cursor, ops: IndexOps): Promise<ApplyResult> {
    const statements: SqlStatement[] = [
      {
        sql: `UPDATE ingest_cursor SET prev_event_id = last_event_id, last_event_id = ?1, last_block_ts = ?2
              WHERE shard = ?3 AND last_event_id = ?4`,
        params: [next.lastEventId, next.lastBlockTs, expected.shard, expected.lastEventId],
      },
      { sql: 'INSERT INTO cursor_guard (x) SELECT 1 WHERE changes() = 0', params: [] },
      bumpRev(this.nowMs()),
      ...pageStatements(ops),
      ...deliveryStatements(next.shard, ops),
    ]
    try {
      await this.db.batch(statements)
      return ok(undefined)
    } catch (e) {
      if (String(e).includes('CHECK constraint failed')) return err({ kind: 'cursor_moved' })
      throw e
    }
  }
}

const bumpRev = (nowMs: number): SqlStatement =>
  ({ sql: 'UPDATE index_meta SET rev = max(rev + 1, ?1) WHERE k = 1', params: [nowMs] })

const json = (v: unknown) => JSON.stringify(v)

/**
 * Splits rows into JSON parameters of at most `PARAM_BYTES`, so a page of long casts never
 * exceeds D1's limit on one bound value.
 */
const PARAM_BYTES = 256 * 1_024
export const chunks = <T>(rows: readonly T[]): T[][] => {
  const out: T[][] = []
  let cur: T[] = []
  let size = 2
  for (const r of rows) {
    const n = new TextEncoder().encode(json(r)).length + 1
    if (cur.length && size + n > PARAM_BYTES) {
      out.push(cur)
      cur = []
      size = 2
    }
    cur.push(r)
    size += n
  }
  if (cur.length) out.push(cur)
  return out
}

/**
 * Members' own-history steps from one page, queued for their user objects (exactly-once
 * delivery). Non-members' steps are dropped by the join, inside the
 * page's transaction, so a FID that joins mid-page gets either all of the page or none.
 */
export const deliveryStatements = (shard: number, ops: IndexOps): SqlStatement[] =>
  chunks(ops.own).map(part => ({
    sql: `INSERT INTO deliveries (fid, shard, event_id, seq, payload)
          SELECT value ->> 'fid', ?2, value ->> 'event_id', value ->> 'seq', value ->> 'p'
          FROM json_each(?1) WHERE (value ->> 'fid') IN (SELECT fid FROM members)
          ON CONFLICT DO NOTHING`,
    params: [json(part), shard],
  }))

export const pageStatements = (ops: IndexOps): SqlStatement[] => {
  const out: SqlStatement[] = []
  for (const part of chunks(ops.castsPut)) out.push({
    sql: `INSERT INTO casts (hash, fid, ts, reply, parent_hash, parent_fid, channel, type, text, embeds, mentions)
          SELECT value ->> 'hash', value ->> 'fid', value ->> 'ts', value ->> 'reply', value ->> 'parent_hash',
                 value ->> 'parent_fid', value ->> 'channel', value ->> 'type', value ->> 'text',
                 value ->> 'embeds', value ->> 'mentions'
          FROM json_each(?1) WHERE true
          ON CONFLICT (hash) DO NOTHING`,
    params: [json(part)],
  })
  if (ops.castsDel.length) {
    // A removed cast becomes a tombstone, so cast.get can say it's gone. Count rows stay until
    // the daily prune: deleting them here would make the result depend on page boundaries.
    out.push({
      sql: `UPDATE casts SET state = 1, text = '', embeds = '[]', mentions = '[]'
            WHERE hash IN (SELECT value FROM json_each(?1)) AND state = 0`,
      params: [json(ops.castsDel)],
    })
  }
  if (ops.recastsPut.length) out.push({
    sql: `INSERT INTO recasts (hash, fid, ts, target_hash, target_fid)
          SELECT value ->> 'hash', value ->> 'fid', value ->> 'ts', value ->> 'target_hash', value ->> 'target_fid'
          FROM json_each(?1) WHERE true
          ON CONFLICT (hash) DO NOTHING`,
    params: [json(ops.recastsPut)],
  })
  if (ops.recastsDel.length) {
    out.push({ sql: 'DELETE FROM recasts WHERE hash IN (SELECT value FROM json_each(?1))', params: [json(ops.recastsDel)] })
  }
  if (ops.counts.length) {
    // Counts are coalesced upserts of raw deltas. A removal can arrive for a reaction from
    // before the index's window, so a stored count can go below zero; readers clamp it. Deltas
    // commute, so the index is the same however events fall into pages.
    out.push({
      sql: `INSERT INTO cast_counts (hash, likes, recasts, replies, first_ts)
            SELECT value ->> 'hash', value ->> 'likes', value ->> 'recasts', value ->> 'replies', value ->> 'ts'
            FROM json_each(?1) WHERE true
            ON CONFLICT (hash) DO UPDATE SET
              likes = likes + excluded.likes,
              recasts = recasts + excluded.recasts,
              replies = replies + excluded.replies,
              first_ts = min(first_ts, excluded.first_ts)`,
      params: [json(ops.counts)],
    })
  }
  for (const field of USER_COLUMNS) {
    const rows = ops.users.filter(u => u.field === field)
    if (!rows.length) continue
    out.push({
      sql: `INSERT INTO users (fid, ${field}, updated_ts)
            SELECT value ->> 'fid', value ->> 'value', value ->> 'ts' FROM json_each(?1) WHERE true
            ON CONFLICT (fid) DO UPDATE SET ${field} = excluded.${field}, updated_ts = max(updated_ts, excluded.updated_ts)`,
      params: [json(rows)],
    })
  }
  return out
}
