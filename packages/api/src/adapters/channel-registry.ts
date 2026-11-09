import { err, ok, parseChannelKey, type Result } from '@warpstack/protocol'
import { z } from 'zod'
import type { ChannelRow } from '../core/rows.ts'
import type { ChannelRegistry, UpstreamError } from '../ports.ts'
import seeded from './seeded-channels.json'

// Channels aren't on Snapchain until V21, so their metadata comes through the
// `ChannelRegistry` port. The client API
// is an operator-run service, now Network School's; the seeded list keeps channel feeds
// working if it goes away, since a channel feed needs only the parent URL.

const ALL_CHANNELS = 'https://api.farcaster.xyz/v2/all-channels'
const FOLLOWING = 'https://api.farcaster.xyz/v1/user-following-channels'
const FOLLOWING_PAGES = 10
const FOLLOWING_TIMEOUT_MS = 8_000
const TIMEOUT_MS = 30_000
const MAX_CHANNELS = 50_000

const ApiChannel = z.object({
  id: z.string(),
  url: z.string(),
  name: z.string().nullish(),
  description: z.string().nullish(),
  imageUrl: z.string().nullish(),
  moderatorFids: z.array(z.number()).nullish(),
  followerCount: z.number().nullish(),
})
const AllChannels = z.object({ result: z.object({ channels: z.array(z.unknown()) }) })
const Following = z.object({ result: z.object({ channels: z.array(z.unknown()) }), next: z.object({ cursor: z.string().max(512).nullish() }).nullish() })

const rowOf = (c: z.infer<typeof ApiChannel>): ChannelRow | null =>
  parseChannelKey(c.id).ok && c.url.length <= 256
    ? {
      key: c.id,
      url: c.url,
      name: (c.name || c.id).slice(0, 256),
      description: c.description?.slice(0, 1_024) ?? null,
      image: c.imageUrl ?? null,
      moderators: (c.moderatorFids ?? []).filter(n => Number.isSafeInteger(n) && n > 0).slice(0, 50),
      follower_count: c.followerCount ?? null,
    }
    : null

export class FarcasterChannelRegistry implements ChannelRegistry {
  constructor(readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  async list() {
    try {
      const res = await this.fetcher(ALL_CHANNELS, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) return err({ kind: 'unavailable' as const, detail: `all-channels: ${res.status}` })
      const body = AllChannels.safeParse(await res.json())
      if (!body.success) return err({ kind: 'bad_response' as const, detail: 'all-channels: unexpected shape' })
      // One malformed channel mustn't drop the rest.
      const rows = body.data.result.channels.slice(0, MAX_CHANNELS).flatMap(c => {
        const parsed = ApiChannel.safeParse(c)
        const row = parsed.success ? rowOf(parsed.data) : null
        return row ? [row] : []
      })
      return ok(rows)
    } catch (e) {
      return err({ kind: 'unavailable' as const, detail: `all-channels: ${String(e)}` })
    }
  }

  /** The channels a FID follows, newest first: pages of 100, at most FOLLOWING_PAGES of them. */
  async followedBy(fid: number): Promise<Result<ChannelRow[], UpstreamError>> {
    const rows: ChannelRow[] = []
    let cursor: string | null | undefined
    try {
      for (let page = 0; page < FOLLOWING_PAGES; page++) {
        const url = `${FOLLOWING}?fid=${fid}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
        const res = await this.fetcher(url, { signal: AbortSignal.timeout(FOLLOWING_TIMEOUT_MS) })
        if (!res.ok) return err({ kind: 'unavailable' as const, detail: `user-following-channels: ${res.status}` })
        const body = Following.safeParse(await res.json())
        if (!body.success) return err({ kind: 'bad_response' as const, detail: 'user-following-channels: unexpected shape' })
        for (const c of body.data.result.channels) {
          const parsed = ApiChannel.safeParse(c)
          const row = parsed.success ? rowOf(parsed.data) : null
          if (row) rows.push(row)
        }
        cursor = body.data.next?.cursor
        if (!cursor) break
      }
      return ok(rows)
    } catch (e) {
      return err({ kind: 'unavailable' as const, detail: `user-following-channels: ${String(e)}` })
    }
  }
}

/** A static list of the most-followed channels, recorded Oct 24, 2026. */
export class SeededChannelRegistry implements ChannelRegistry {
  async list() {
    return ok(seeded as ChannelRow[])
  }
}
