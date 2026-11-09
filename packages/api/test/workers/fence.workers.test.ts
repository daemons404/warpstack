import type { EventId, ShardIndex, Timestamp } from '@warpstack/protocol'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { D1Sql } from '../../src/adapters/d1.ts'
import { SqlIndexWriter } from '../../src/adapters/index-writer.ts'
import { emptyOps } from '../../src/core/rows.ts'

const DB = (env as unknown as { DB: D1Database }).DB
const SHARD = 1 as ShardIndex
const at = (id: number, ts = 1_793_000_000) => ({ shard: SHARD, lastEventId: id as EventId, lastBlockTs: ts as Timestamp })

const castRow = (hash: string) => ({
  hash, fid: 1, ts: 1_793_000_000, reply: 0 as const, parent_hash: null, parent_fid: null, channel: null,
  type: 'cast' as const, text: 'x', embeds: '[]', mentions: '[]',
})

describe('the cursor fence on real D1', () => {
  it('commits a page and its cursor together, and rolls back a stale page entirely', async () => {
    const w = new SqlIndexWriter(new D1Sql(DB), () => 1_793_000_000_000)
    await w.resetCursor(at(100))
    const ops = { ...emptyOps(), castsPut: [castRow(`0x${'a'.repeat(40)}`)] }
    expect((await w.applyPage(at(100), at(200), ops)).ok).toBe(true)

    // A stale instance, or a retry after a crash, starts from the old cursor.
    const stale = { ...emptyOps(), castsPut: [castRow(`0x${'b'.repeat(40)}`)] }
    expect(await w.applyPage(at(100), at(300), stale)).toEqual({ ok: false, error: { kind: 'cursor_moved' } })

    const { results } = await DB.prepare('SELECT hash FROM casts ORDER BY hash').all<{ hash: string }>()
    expect(results.map(r => r.hash)).toEqual([`0x${'a'.repeat(40)}`])
    expect((await w.cursor(SHARD))?.lastEventId).toBe(200)
  })
})
