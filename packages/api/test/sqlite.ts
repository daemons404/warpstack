import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
// node:sqlite needs --experimental-sqlite on Node 23.1; the unit project passes it.
import { DatabaseSync } from 'node:sqlite'
import type { Sql, SqlStatement } from '../src/ports.ts'

const MIGRATIONS = join(import.meta.dirname, '..', 'migrations')

/**
 * The `Sql` port on an in-memory SQLite database, with the same migrations as D1. It runs
 * the real SQL in `pnpm check`; the Miniflare suite runs the same tests against D1.
 */
export class MemorySql implements Sql {
  readonly db = new DatabaseSync(':memory:')

  constructor() {
    for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()) {
      this.db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'))
    }
  }

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const [q, args] = numbered(sql, params)
    return this.db.prepare(q).all(...(args as never[])) as T[]
  }

  async batch(statements: readonly SqlStatement[]): Promise<void> {
    this.db.exec('BEGIN')
    try {
      for (const s of statements) {
        const [q, args] = numbered(s.sql, s.params)
        this.db.prepare(q).run(...(args as never[]))
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
}

/** The index as readers see it, for comparing two ingestion runs. */
export const indexSnapshot = async (db: MemorySql) => ({
  casts: await db.all('SELECT hash, fid, ts, reply, parent_hash, channel, text, state FROM casts ORDER BY hash'),
  recasts: await db.all('SELECT * FROM recasts ORDER BY hash'),
  // Counts as readers see them: a missing row and an all-zero row both mean zero. Deltas that
  // cancel within one page write no row; split across pages, they leave a zero row behind.
  counts: await db.all(`SELECT hash, max(0, likes) likes, max(0, recasts) recasts, max(0, replies) replies FROM cast_counts
                        WHERE likes <> 0 OR recasts <> 0 OR replies <> 0 ORDER BY hash`),
  users: await db.all('SELECT fid, username, display, pfp FROM users ORDER BY fid'),
})

/** node:sqlite doesn't bind `?NNN` parameters; D1 does. Rewrite them as named ones. */
const numbered = (sql: string, params: readonly unknown[]): [string, unknown[]] => {
  if (!/\?\d/.test(sql)) return [sql, [...params]]
  const named = Object.fromEntries(params.map((p, i) => [`p${i + 1}`, p]))
  return [sql.replace(/\?(\d+)/g, (_, n) => `$p${n}`), [named]]
}
