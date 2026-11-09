import { exports } from 'cloudflare:workers'
import { env } from 'cloudflare:workers'
import { beforeAll, describe, expect, it } from 'vitest'

const DB = (env as unknown as { DB: D1Database }).DB
const worker = (exports as unknown as { default: { fetch: (r: Request) => Promise<Response> } }).default
const get = (path: string, headers: Record<string, string> = {}) => worker.fetch(new Request(`https://reader.test${path}`, { headers }))

const NOW = Math.floor(Date.now() / 1000)
const HASH = `0x${'c'.repeat(40)}`

beforeAll(async () => {
  // An index with both shards current, one channel, and a cast by an author whose profile is hostile.
  await DB.batch([
    DB.prepare('INSERT INTO ingest_cursor VALUES (1, 1, 1, ?1, ?2), (2, 1, 1, ?1, ?2)').bind(NOW - 5, NOW - 3_600),
    DB.prepare(`INSERT INTO channels (key, url, name, description, image, moderators, follower_count, updated_ts)
                VALUES ('base', 'https://farcaster.xyz/~/channel/base', 'Base', NULL, NULL, '[]', 10, ?1)`).bind(NOW),
    DB.prepare(`INSERT INTO users (fid, username, display, pfp, url, complete, updated_ts, verified, counts_ts, followers, following)
                VALUES (66, 'Not A Name', 'Eve', 'https:evil.example', 'https:/evil.example', 1, ?1, '[]', ?1, 1, 1)`).bind(NOW),
    DB.prepare(`INSERT INTO casts (hash, fid, ts, reply, parent_hash, parent_fid, channel, type, text, embeds, mentions)
                VALUES (?1, 66, ?2, 0, NULL, NULL, 'https://farcaster.xyz/~/channel/base', 'cast', 'hello', '[]', '[]')`).bind(HASH, NOW - 60),
  ])
})

describe('the Worker, end to end', () => {
  it('serves a channel feed whose author has hostile profile data, through output validation', async () => {
    const res = await get('/api/channels/base/feed')
    expect(res.status).toBe(200)
    const body = await res.json() as { items: { author: { fid: number; username?: string } }[]; next: { kind: string } }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]!.author).toEqual({ fid: 66, displayName: 'Eve', pro: false })
    expect(body.next).toEqual({ kind: 'horizon' })
  })

  it('derives Cache-Control from the route\'s facts', async () => {
    expect((await get('/api/channels/base/feed')).headers.get('cache-control')).toBe('public, max-age=30, stale-while-revalidate=30')
    expect((await get('/api/channels/base')).headers.get('cache-control')).toBe('public, max-age=3600, stale-while-revalidate=3600')
  })

  it('gives every viewer identical bytes for a public URL, whatever credentials they send', async () => {
    const a = await (await get('/api/channels/base/feed')).text()
    const b = await (await get('/api/channels/base/feed', { authorization: 'Warpstack fid=1, key=0x00', cookie: 'session=1' })).text()
    expect(b).toBe(a)
  })

  it('answers input that fails its schema with BAD_INPUT and its issues', async () => {
    const res = await get('/api/casts/0/0xnothex')
    expect(res.status).toBe(400)
    const body = await res.json() as { code: string; data: { issues: { path: string }[] } }
    expect(body.code).toBe('BAD_INPUT')
    expect(body.data.issues.map(i => i.path)).toEqual(expect.arrayContaining(['fid', 'hash']))
  })

  it('refuses non-canonical FIDs in paths', async () => {
    for (const fid of ['1.5', '-1', 'abc']) expect((await get(`/api/users/${fid}`)).status).toBe(400)
  })

  it('answers an unknown API path with the contract\'s NOT_FOUND, never cached', async () => {
    const res = await get('/api/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND')
  })

  it('reports capabilities with this deployment\'s origin', async () => {
    const body = await (await get('/api/meta')).json() as { contract: string; status: string; origins: { api: string } }
    expect(body).toMatchObject({ contract: '0.3.0', status: 'ok', origins: { api: 'https://reader.test' } })
  })

  it('serves a deleted cast as a tombstone', async () => {
    await DB.prepare("UPDATE casts SET state = 1, text = '' WHERE hash = ?1").bind(HASH).run()
    const body = await (await get(`/api/casts/66/${HASH}`)).json() as { cast: { state: string } }
    expect(body.cast.state).toBe('deleted')
  })
})
