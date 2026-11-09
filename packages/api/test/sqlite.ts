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

/** node:sqlite doesn't bind `?NNN` parameters; D1 does. Rewrite them as named ones. */
const numbered = (sql: string, params: readonly unknown[]): [string, unknown[]] => {
  if (!/\?\d/.test(sql)) return [sql, [...params]]
  const named = Object.fromEntries(params.map((p, i) => [`p${i + 1}`, p]))
  return [sql.replace(/\?(\d+)/g, (_, n) => `$p${n}`), [named]]
}
