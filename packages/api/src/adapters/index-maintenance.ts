import type { ChannelRow, UserField } from '../core/rows.ts'
import type { Sql } from '../ports.ts'

export type UserFill = {
  fid: number
  fields: Partial<Record<UserField, string | null>>
  ts: number
  pro?: boolean | undefined
  verified?: { address: string; protocol: 'ethereum' | 'solana' }[] | undefined
  counts?: { followers: number; following: number; bounded: boolean } | undefined
  /** When the bounded counts were taken, in Unix seconds. */
  countsTs?: number | undefined
}

const FIELDS: readonly UserField[] = ['username', 'display', 'pfp', 'bio', 'url', 'location', 'banner', 'primary_addr']

/** Writes outside the event fold: lazy profile fills, channel refreshes and retention. */
export class IndexMaintenance {
  constructor(private readonly db: Sql) {}

  /** Drops follow lists older than `before`; they're reread on the next request. */
  async pruneFollowing(before: number): Promise<void> {
    await this.db.batch([{ sql: 'DELETE FROM following_cache WHERE ts < ?1', params: [before] }])
  }

  /** Caches the accounts a FID follows, as read from the node. */
  async putFollowing(fid: number, fids: readonly number[], complete: boolean, ts: number): Promise<void> {
    await this.db.batch([{
      sql: `INSERT INTO following_cache (fid, fids, complete, ts) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT (fid) DO UPDATE SET fids = excluded.fids, complete = excluded.complete, ts = excluded.ts`,
      params: [fid, JSON.stringify(fids), complete ? 1 : 0, ts],
    }])
  }

  /**
   * Profiles read from `userData` on a miss. Field by field, a stored value that is newer than
   * the fill's messages is kept, whether it came from an event or an earlier fill, so a slow
   * fill can't roll back a change ingestion folded in while it ran. Missing fields are filled.
   */
  async fillUsers(fills: readonly UserFill[]): Promise<void> {
    if (!fills.length) return
    await this.db.batch(fills.map(f => {
      const cols = FIELDS.map(c => f.fields[c] ?? null)
      return {
        sql: `INSERT INTO users (fid, ${FIELDS.join(', ')}, complete, updated_ts)
              VALUES (?1, ${FIELDS.map((_, i) => `?${i + 2}`).join(', ')}, 1, ?10)
              ON CONFLICT (fid) DO UPDATE SET
                ${FIELDS.map(c => `${c} = CASE WHEN users.updated_ts > ?10 AND users.${c} IS NOT NULL THEN users.${c} ELSE excluded.${c} END`).join(',\n')},
                complete = 1,
                updated_ts = max(users.updated_ts, ?10)`,
        params: [f.fid, ...cols, f.ts],
      }
    }).concat(fills.filter(f => f.pro !== undefined || f.verified || f.counts).map(f => ({
      sql: `UPDATE users SET
              pro = coalesce(?2, pro),
              verified = coalesce(?3, verified),
              followers = coalesce(?4, followers),
              following = coalesce(?5, following),
              counts_bounded = coalesce(?6, counts_bounded),
              counts_ts = coalesce(?7, counts_ts)
            WHERE fid = ?1`,
      params: [
        f.fid,
        f.pro === undefined ? null : f.pro ? 1 : 0,
        f.verified ? JSON.stringify(f.verified) : null,
        f.counts?.followers ?? null,
        f.counts?.following ?? null,
        f.counts ? (f.counts.bounded ? 1 : 0) : null,
        f.counts ? (f.countsTs ?? f.ts) : null,
      ],
    }))))
  }

  async putChannels(rows: readonly ChannelRow[], ts: number): Promise<void> {
    const CHUNK = 500
    const statements = []
    for (let i = 0; i < rows.length; i += CHUNK) {
      statements.push({
        sql: `INSERT INTO channels (key, url, name, description, image, moderators, follower_count, updated_ts)
              SELECT value ->> 'key', value ->> 'url', value ->> 'name', value ->> 'description', value ->> 'image',
                     value ->> 'moderators', value ->> 'follower_count', ?2
              FROM json_each(?1) WHERE true
              ON CONFLICT (key) DO UPDATE SET url = excluded.url, name = excluded.name, description = excluded.description,
                image = excluded.image, moderators = excluded.moderators, follower_count = excluded.follower_count,
                updated_ts = excluded.updated_ts`,
        params: [JSON.stringify(rows.slice(i, i + CHUNK).map(r => ({ ...r, moderators: JSON.stringify(r.moderators) }))), ts],
      })
    }
    await this.db.batch(statements)
  }

  /**
   * Deletes casts, recasts and count rows older than `before`, at most `batch` of each per
   * call, through their time indexes (`DELETE … LIMIT` isn't in every SQLite build). Returns
   * how many rows each table lost, so the caller loops until every table is done.
   */
  async prune(before: number, batch: number): Promise<{ casts: number; recasts: number; counts: number }> {
    const count = async (sql: string) => (await this.db.all<{ n: number }>(sql, [before, batch]))[0]?.n ?? 0
    const [casts, recasts, counts] = await Promise.all([
      count('SELECT count(*) AS n FROM (SELECT hash FROM casts WHERE ts < ?1 LIMIT ?2)'),
      count('SELECT count(*) AS n FROM (SELECT hash FROM recasts WHERE ts < ?1 LIMIT ?2)'),
      count('SELECT count(*) AS n FROM (SELECT hash FROM cast_counts WHERE first_ts < ?1 LIMIT ?2)'),
    ])
    await this.db.batch([
      { sql: 'DELETE FROM casts WHERE hash IN (SELECT hash FROM casts WHERE ts < ?1 ORDER BY ts LIMIT ?2)', params: [before, batch] },
      { sql: 'DELETE FROM recasts WHERE hash IN (SELECT hash FROM recasts WHERE ts < ?1 ORDER BY ts LIMIT ?2)', params: [before, batch] },
      { sql: 'DELETE FROM cast_counts WHERE hash IN (SELECT hash FROM cast_counts WHERE first_ts < ?1 ORDER BY first_ts LIMIT ?2)', params: [before, batch] },
    ])
    return { casts, recasts, counts }
  }
}
