import type { Sql, SqlStatement } from '../ports.ts'

/** The `Sql` port on D1. `batch()` runs as one transaction. */
export class D1Sql implements Sql {
  constructor(private readonly db: D1Database) {}

  async all<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const { results } = await this.db.prepare(sql).bind(...params).all<T>()
    return results
  }

  async batch(statements: readonly SqlStatement[]): Promise<void> {
    if (!statements.length) return
    await this.db.batch(statements.map(s => this.db.prepare(s.sql).bind(...s.params)))
  }
}
