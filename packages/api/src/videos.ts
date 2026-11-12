import { VIDEO_LIMITS } from '@warpstack/contract'
import { err, ok, type Result } from '@warpstack/protocol'
import { STREAM_HOST } from './adapters/stream.ts'
import type { Media } from './media.ts'
import type { Clock, Sql, VideoHost } from './ports.ts'

// Members' videos. Optional: without a video host (a Cloudflare Stream token) uploads are off
// and everything else works. Each upload costs the owner per minute stored and watched, so
// they're counted per member and per deployment per day, and Stream refuses anything longer
// than VIDEO_LIMITS.maxSeconds. The device sends the file straight to Stream; this only hands
// out the one-time URL and records what came of it.

/** A one-time upload URL works for this long. */
export const UPLOAD_WINDOW_SECONDS = 30 * 60
const DAY = 86_400

/**
 * Farcaster's own video servers. Their videos play in the app like they do in the Farcaster
 * client; a video anywhere else stays a link, so a cast can't make a phone contact a host the
 * poster chose.
 */
export const FARCASTER_VIDEO_HOSTS: ReadonlySet<string> = new Set(['stream.warpcast.com', 'stream.farcaster.xyz'])
const PLAYABLE_PATH = /\.(m3u8|mp4)$/i

export type VideoError =
  | { kind: 'off' }
  | { kind: 'limit'; why: string }
  | { kind: 'not_found' }
  | { kind: 'upstream'; detail: string }

export type VideoStatus = { state: 'processing' } | { state: 'ready'; url: string } | { state: 'failed'; reason: string }

export type VideoEmbed = {
  kind: 'video'
  url: string
  domain: string
  width?: number
  height?: number
  duration?: number
  poster?: { media: string; width: number; height: number }
}

type Row = {
  id: string; fid: number; status: string; hls: string | null; width: number | null; height: number | null; duration: number | null
  poster: string | null; poster_w: number | null; poster_h: number | null
}

export type VideoDeps = {
  db: Sql
  clock: Clock
  /** Stream on the deployment's account; without it, uploads are off. */
  host?: VideoHost | undefined
  /** Stores the poster through the image pipeline, when images are on. */
  media?: Media | undefined
}

export class Videos {
  constructor(private readonly d: VideoDeps) {}

  get enabled(): boolean {
    return Boolean(this.d.host)
  }

  /** A one-time upload URL for `fid`, within the day's limits. */
  async start(fid: number): Promise<Result<{ id: string; uploadUrl: string }, VideoError>> {
    if (!this.d.host) return err({ kind: 'off' })
    const now = this.d.clock.now()
    const [counts] = await this.d.db.all<{ mine: number; all: number }>(
      'SELECT (SELECT count(*) FROM videos WHERE fid = ?1 AND ts > ?2) AS mine, (SELECT count(*) FROM videos WHERE ts > ?2) AS "all"', [fid, now - DAY])
    if ((counts?.mine ?? 0) >= VIDEO_LIMITS.perFidPerDay) return err({ kind: 'limit', why: `You can post ${VIDEO_LIMITS.perFidPerDay} videos a day. Try again tomorrow.` })
    if ((counts?.all ?? 0) >= VIDEO_LIMITS.perDeploymentPerDay) return err({ kind: 'limit', why: 'This server has had its videos for today. Try again tomorrow.' })
    const r = await this.d.host.createUpload({ maxSeconds: VIDEO_LIMITS.maxSeconds, creator: `fid:${fid}`, expiresAt: now + UPLOAD_WINDOW_SECONDS })
    if (!r.ok) return err({ kind: 'upstream', detail: r.error.detail })
    await this.d.db.batch([{ sql: 'INSERT INTO videos (id, fid, status, ts) VALUES (?1, ?2, \'processing\', ?3)', params: [r.value.id, fid, now] }])
    return ok(r.value)
  }

  /** Where `fid`'s upload is. Once ready, its size and poster are recorded and its URL can be embedded. */
  async status(id: string, fid: number): Promise<Result<VideoStatus, VideoError>> {
    if (!this.d.host) return err({ kind: 'off' })
    const [row] = await this.d.db.all<Row>('SELECT * FROM videos WHERE id = ?1 AND fid = ?2', [id, fid])
    if (!row) return err({ kind: 'not_found' })
    if (row.status === 'ready' && row.hls) return ok({ state: 'ready', url: row.hls })
    if (row.status === 'failed') return ok({ state: 'failed', reason: 'Stream couldn\'t process the video.' })
    const r = await this.d.host.status(id)
    if (!r.ok) return err({ kind: 'upstream', detail: r.error.detail })
    const s = r.value
    if (s.state === 'processing') return ok(s)
    if (s.state === 'failed') {
      await this.d.db.batch([{ sql: 'UPDATE videos SET status = \'failed\' WHERE id = ?1', params: [id] }])
      return ok({ state: 'failed', reason: s.reason })
    }
    // The poster goes through the image pipeline like any image: fetched the restricted way and
    // re-encoded. Without images, the video simply has no poster.
    const poster = s.thumbnail && this.d.media?.enabled ? await this.d.media.store(s.thumbnail, 'image').catch(() => null) : null
    await this.d.db.batch([{
      sql: `UPDATE videos SET status = 'ready', hls = ?2, width = ?3, height = ?4, duration = ?5, poster = ?6, poster_w = ?7, poster_h = ?8 WHERE id = ?1`,
      params: [id, s.hls, s.width ?? null, s.height ?? null, s.duration ?? null, poster?.key ?? null, poster?.width ?? null, poster?.height ?? null],
    }])
    return ok({ state: 'ready', url: s.hls })
  }

  /**
   * What a video URL in a cast is, without fetching it: a video on Farcaster's servers, or one of
   * this deployment's own uploads. Null for anything else, which is then treated as any link.
   */
  async embed(url: string): Promise<VideoEmbed | null> {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return null
    }
    if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return null
    if (FARCASTER_VIDEO_HOSTS.has(u.host) && PLAYABLE_PATH.test(u.pathname)) return { kind: 'video', url, domain: u.host }
    if (!STREAM_HOST.test(u.host)) return null
    const [row] = await this.d.db.all<Row>('SELECT * FROM videos WHERE hls = ?1 AND status = \'ready\'', [url])
    if (!row) return null
    return {
      kind: 'video',
      url,
      domain: u.host,
      ...(row.width ? { width: row.width } : {}),
      ...(row.height ? { height: row.height } : {}),
      ...(row.duration ? { duration: row.duration } : {}),
      ...(row.poster && row.poster_w && row.poster_h ? { poster: { media: row.poster, width: row.poster_w, height: row.poster_h } } : {}),
    }
  }
}
