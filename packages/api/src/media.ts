import { EmbedMetadata } from '@warpstack/contract'
import {
  checkImage, checkUrl, hostOf, IMAGE_LIMITS, PAGE_LIMITS, plainText, PREVIEW_CAPS, readPreview, untrustedFetch, type AddressPolicy, type Fetched, type ImageInfo,
} from './adapters/fetchers/index.ts'
import type { Clock, Sql } from './ports.ts'

// Images and link previews. Every remote URL is fetched once
// through the restricted transport, checked, and, if it's an image, decoded and re-encoded by
// Cloudflare's Images binding before it is stored in R2 and served from the media origin.
// Nothing is passed through: a phone only ever decodes bytes Cloudflare's encoder wrote, and
// without the binding nothing is stored at all (fail closed).

/** Avatars are stored once, square, at this size: 48 points at 3x. */
export const AVATAR_SIZE = 144
/** Proxied images are stored at most this wide. */
export const IMAGE_WIDTH = 1_080
/** A source that failed is tried again after this long. */
export const RETRY_FAILED_SECONDS = 86_400
/** At most this many avatars are fetched for one request, in the background. */
export const AVATARS_PER_REQUEST = 6
/** A followed-channels import names many images at once, so it may ask for this many. */
export const IMPORT_IMAGES_PER_REQUEST = 24
/** Square images fetched at once in the background: within the transport's per-isolate limit. */
const SQUARES_AT_ONCE = 3

const EMBED_OK_SECONDS = 3 * 86_400
const EMBED_FAILED_SECONDS = 3_600
const IMAGE_ACCEPT = 'image/webp,image/png,image/jpeg,image/gif'
const EMBED_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,image/webp;q=0.8,image/png;q=0.8,image/jpeg;q=0.8,image/gif;q=0.8'
/** A URL named like an image is asked for as one: Giphy and Tenor send a page to anyone who'd take HTML. */
const IMAGE_FIRST_ACCEPT = 'image/webp,image/png,image/jpeg,image/gif,text/html;q=0.5'
const looksLikeImage = (url: string) => /\.(gif|png|jpe?g|webp)$/i.test(new URL(url).pathname)

/**
 * YouTube's watch pages put their Open Graph tags past what a preview reads, so a YouTube
 * link is described by YouTube's oEmbed answer instead: a small JSON with the title and a
 * thumbnail, fetched the same restricted way.
 */
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'])
const youtubeOembed = (url: string): string | null =>
  YOUTUBE_HOSTS.has(hostOf(url) ?? '') ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}` : null

export type MediaKind = 'avatar' | 'image'
export type Stored = { key: string; width: number; height: number }
export type MediaOutcome<T> = Outcome<T>

export type MediaDeps = {
  db: Sql
  clock: Clock
  policy: AddressPolicy
  /** R2 and the Images binding; without both, nothing is stored and images stay links. */
  bucket?: R2Bucket | undefined
  images?: ImagesBinding | undefined
  /** The deployment-wide admission limit on untrusted fetches; false means not now. */
  admit: () => Promise<boolean>
  /** The runtime's fetch; injected so tests can play hostile servers. */
  fetcher?: typeof fetch
  /** Where stored images are served; uploads are named by URLs on it. */
  mediaOrigin?: string | undefined
}

/** A failure worth remembering (the source is bad) or not (we were busy). */
type Failure = { transient: boolean; why: string }
type Outcome<T> = { ok: true; value: T } | { ok: false; error: Failure }
const fail = (why: string, transient = false): Outcome<never> => ({ ok: false, error: { transient, why } })

export class TransientError extends Error {}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')
export const sha256Hex = async (data: string | Uint8Array): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data))

/** Where an avatar for this URL is (or will be) stored: fixed by the URL, so it can be named before it's fetched. */
export const avatarKey = async (src: string): Promise<string> => `a/${await sha256Hex(src)}/${AVATAR_SIZE}`

const streamOf = (bytes: Uint8Array) => new Response(bytes).body!

/** Sources being fetched in this isolate, so a burst of pages doesn't fetch one avatar many times. */
const inFlight = new Set<string>()

export class Media {
  constructor(private readonly d: MediaDeps) {}

  /** Whether members can post images: stored and served from a media origin. */
  get uploads(): boolean {
    return this.enabled && Boolean(this.d.mediaOrigin)
  }

  /** Whether images can be stored at all. */
  get enabled(): boolean {
    return Boolean(this.d.bucket && this.d.images)
  }

  /** Square images (avatars, channel images) a response named that aren't stored yet; runs after the response, a few at a time. */
  async storeAvatars(srcs: readonly string[]): Promise<void> {
    if (!this.enabled) return
    const queue = srcs.slice(0, IMPORT_IMAGES_PER_REQUEST)
    const worker = async () => {
      for (let src = queue.shift(); src !== undefined; src = queue.shift()) {
        try {
          await this.store(src, 'avatar')
        } catch (e) {
          console.warn(`avatar: ${String(e).slice(0, 200)}`)
        }
      }
    }
    await Promise.all(Array.from({ length: SQUARES_AT_ONCE }, worker))
  }

  /** The stored image for a remote URL, fetching and re-encoding it if needed; null if it can't be. */
  async store(src: string, kind: MediaKind, fetched?: Fetched): Promise<Stored | null> {
    if (!this.enabled) return null
    const now = this.d.clock.now()
    const [row] = await this.d.db.all<{ status: string; key: string | null; width: number | null; height: number | null; ts: number }>(
      'SELECT status, key, width, height, ts FROM media_sources WHERE src = ?1 AND kind = ?2', [src, kind])
    if (row?.status === 'ok' && row.key && row.width && row.height) return { key: row.key, width: row.width, height: row.height }
    if (row?.status === 'failed' && now - row.ts < RETRY_FAILED_SECONDS) return null
    const flight = `${kind} ${src}`
    if (inFlight.has(flight)) throw new TransientError('already fetching')
    inFlight.add(flight)
    try {
      const r = await this.fetchAndEncode(src, kind, fetched)
      if (!r.ok) {
        if (r.error.transient) throw new TransientError(r.error.why)
        await this.d.db.batch([{
          sql: `INSERT INTO media_sources (src, kind, status, ts) VALUES (?1, ?2, 'failed', ?3)
                ON CONFLICT (src, kind) DO UPDATE SET status = 'failed', key = NULL, ts = ?3`,
          params: [src, kind, now],
        }])
        return null
      }
      const { key, width, height, sha } = r.value
      await this.d.db.batch([{
        sql: `INSERT INTO media_sources (src, kind, status, key, width, height, sha256, ts) VALUES (?1, ?2, 'ok', ?3, ?4, ?5, ?6, ?7)
              ON CONFLICT (src, kind) DO UPDATE SET status = 'ok', key = ?3, width = ?4, height = ?5, sha256 = ?6, ts = ?7`,
        params: [src, kind, key, width, height, sha, now],
      }])
      return { key, width, height }
    } finally {
      inFlight.delete(flight)
    }
  }

  private async takenDown(keys: readonly string[]): Promise<boolean> {
    const rows = await this.d.db.all<{ key: string }>('SELECT key FROM takedowns WHERE key IN (SELECT value FROM json_each(?1))', [JSON.stringify(keys)])
    return rows.length > 0
  }

  private async fetchAndEncode(src: string, kind: MediaKind, prefetched?: Fetched): Promise<Outcome<Stored & { sha: string }>> {
    if (await this.takenDown([src])) return fail('taken down')
    let fetched = prefetched
    if (!fetched) {
      if (!(await this.d.admit())) return fail('admission limit', true)
      const r = await untrustedFetch(src, { policy: this.d.policy, limits: IMAGE_LIMITS, accept: IMAGE_ACCEPT, fetcher: this.d.fetcher })
      if (!r.ok) return fail(r.error.kind, r.error.kind === 'busy' || r.error.kind === 'timeout' || r.error.kind === 'network')
      fetched = r.value
    }
    const info = checkImage(fetched.bytes)
    if (!info.ok) return fail(info.error)
    const sha = await sha256Hex(fetched.bytes)
    if (await this.takenDown([sha])) return fail('taken down')

    const encoded = await this.reencode(fetched.bytes, info.value, kind)
    if (!encoded.ok) return encoded
    const { out, width, height } = encoded.value

    const key = kind === 'avatar' ? await avatarKey(src) : `p/${await sha256Hex(src)}/${width}`
    await this.d.bucket!.put(key, out, {
      httpMetadata: { contentType: 'image/webp' },
      customMetadata: { sha256: sha },
    })
    return { ok: true, value: { key, width, height, sha } }
  }

  /**
   * Decodes and re-encodes an image inside Cloudflare, so the stored bytes are the encoder's,
   * not the source's: avatars as a square, everything else at most IMAGE_WIDTH wide, animation
   * kept. Anything the encoder returns that isn't a plain WebP is refused.
   */
  private async reencode(bytes: Uint8Array, info: ImageInfo, kind: MediaKind | 'upload'): Promise<Outcome<{ out: Uint8Array; width: number; height: number }>> {
    const avatar = kind === 'avatar'
    const width = avatar ? AVATAR_SIZE : Math.min(info.width, IMAGE_WIDTH)
    const height = avatar ? AVATAR_SIZE : Math.max(1, Math.round(info.height * width / info.width))
    let out: Uint8Array
    try {
      const result = await this.d.images!.input(streamOf(bytes))
        .transform(avatar ? { width: AVATAR_SIZE, height: AVATAR_SIZE, fit: 'cover' } : { width, fit: 'scale-down' })
        .output({ format: 'image/webp', quality: 85, anim: !avatar && info.frames > 1 })
      out = new Uint8Array(await new Response(result.image()).arrayBuffer())
    } catch (e) {
      return fail(`re-encode: ${String(e).slice(0, 120)}`)
    }
    const check = checkImage(out)
    if (!check.ok || check.value.type !== 'webp') return fail('re-encode produced something unexpected')
    // The guarantee is on what's published: nothing stored may carry EXIF, XMP or text chunks,
    // whatever the source or the phone sent.
    if (check.value.metadata) return fail('re-encode kept metadata')
    return { ok: true, value: { out, width: check.value.width || width, height: check.value.height || height } }
  }

  /**
   * An image a member posts (media.upload). The device has already resized and re-encoded it,
   * which drops location; iOS's encoder still writes a small EXIF block (orientation, size,
   * color space), so the upload's own metadata isn't refused. The original never leaves this
   * server and isn't stored: it's re-encoded like everything else, and the result is refused if
   * it carries any metadata at all. Stored at `u/{sha256}/{width}` and served publicly, since a
   * posted cast names it.
   */
  async storeUpload(bytes: Uint8Array, fid: number): Promise<Outcome<Stored & { url: string }>> {
    if (!this.enabled || !this.d.mediaOrigin) return fail('images are off')
    const info = checkImage(bytes)
    if (!info.ok) return fail(info.error)
    const sha = await sha256Hex(bytes)
    if (await this.takenDown([sha])) return fail('this image was taken down')
    const urlOf = (key: string) => `${this.d.mediaOrigin}/img/${key}`
    const [prior] = await this.d.db.all<{ key: string; width: number; height: number }>('SELECT key, width, height FROM uploads WHERE sha256 = ?1', [sha])
    if (prior) return { ok: true, value: { ...prior, url: urlOf(prior.key) } }
    const encoded = await this.reencode(bytes, info.value, 'upload')
    if (!encoded.ok) return encoded
    const { out, width, height } = encoded.value
    const key = `u/${sha}/${width}`
    await this.d.bucket!.put(key, out, { httpMetadata: { contentType: 'image/webp' }, customMetadata: { sha256: sha } })
    await this.d.db.batch([{
      sql: 'INSERT INTO uploads (sha256, key, fid, width, height, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING',
      params: [sha, key, fid, width, height, this.d.clock.now()],
    }])
    return { ok: true, value: { key, width, height, url: urlOf(key) } }
  }

  /**
   * What a URL embed is. `url` must come from an indexed cast's embeds (the route looks it
   * up); the domain shown is always the URL's own, never what the page claims. Throws
   * TransientError when it can't say right now, so the answer isn't cached.
   */
  async embed(url: string): Promise<EmbedMetadata> {
    const domain = hostOf(url) ?? 'unknown'
    const unknown: EmbedMetadata = { kind: 'unknown', domain }
    const now = this.d.clock.now()
    const [cached] = await this.d.db.all<{ ok: number; json: string; ts: number }>('SELECT ok, json, ts FROM embed_meta WHERE url = ?1', [url])
    if (cached && now - cached.ts < (cached.ok ? EMBED_OK_SECONDS : EMBED_FAILED_SECONDS)) {
      const parsed = EmbedMetadata.safeParse(JSON.parse(cached.json))
      if (parsed.success) return parsed.data
    }
    // A member's own upload, on our media origin: answered from the uploads table, never fetched.
    if (this.d.mediaOrigin && url.startsWith(`${this.d.mediaOrigin}/img/u/`)) {
      const [u] = await this.d.db.all<{ key: string; width: number; height: number }>('SELECT key, width, height FROM uploads WHERE key = ?1', [url.slice(`${this.d.mediaOrigin}/img/`.length)])
      return u ? { kind: 'image', media: u.key as never, width: u.width, height: u.height } : unknown
    }
    if (!checkUrl(url, this.d.policy).ok || (await this.takenDown([url]))) return this.remember(url, unknown, false)
    if (!(await this.d.admit())) throw new TransientError('admission limit')
    const oembed = youtubeOembed(url)
    if (oembed) return this.youtube(url, oembed, domain)
    const accept = looksLikeImage(url) ? IMAGE_FIRST_ACCEPT : EMBED_ACCEPT
    const r = await untrustedFetch(url, { policy: this.d.policy, limits: IMAGE_LIMITS, accept, fetcher: this.d.fetcher })
    if (!r.ok) {
      if (r.error.kind === 'busy' || r.error.kind === 'timeout' || r.error.kind === 'network') throw new TransientError(r.error.kind)
      return this.remember(url, unknown, false)
    }
    const fetched = r.value

    // An image, by its bytes, whatever the URL or headers say.
    if (checkImage(fetched.bytes).ok) {
      const stored = await this.store(url, 'image', fetched)
      return stored
        ? this.remember(url, { kind: 'image', media: stored.key as never, width: stored.width, height: stored.height }, true)
        : this.remember(url, unknown, false)
    }

    // A page: Open Graph tags from its head, as plain text, plus its preview image, re-encoded.
    if (!/^(text\/html|application\/xhtml\+xml)\b/.test(fetched.contentType)) return this.remember(url, unknown, false)
    const html = new TextDecoder().decode(fetched.bytes.subarray(0, PAGE_LIMITS.maxBytes))
    const preview = readPreview(html)
    let image: Stored | null = null
    if (preview.image) {
      try {
        const abs = new URL(preview.image, fetched.url).href
        image = await this.store(abs, 'image')
      } catch {
        image = null
      }
    }
    const link: EmbedMetadata = {
      kind: 'link',
      domain,
      ...(preview.title ? { title: preview.title } : {}),
      ...(preview.description ? { description: preview.description } : {}),
      ...(preview.site ? { site: preview.site } : {}),
      ...(image ? { image: { media: image.key as never, width: image.width, height: image.height } } : {}),
    }
    const valid = EmbedMetadata.safeParse(link)
    return valid.success ? this.remember(url, valid.data, true) : this.remember(url, unknown, false)
  }

  /** A YouTube link, from YouTube's oEmbed JSON: its title, channel and thumbnail. */
  private async youtube(url: string, oembed: string, domain: string): Promise<EmbedMetadata> {
    const unknown: EmbedMetadata = { kind: 'unknown', domain }
    const r = await untrustedFetch(oembed, { policy: this.d.policy, limits: PAGE_LIMITS, accept: 'application/json', fetcher: this.d.fetcher })
    if (!r.ok) {
      if (r.error.kind === 'busy' || r.error.kind === 'timeout' || r.error.kind === 'network') throw new TransientError(r.error.kind)
      return this.remember(url, unknown, false)
    }
    let o: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(r.value.bytes))
      if (typeof parsed !== 'object' || parsed === null) return this.remember(url, unknown, false)
      o = parsed as Record<string, unknown>
    } catch {
      return this.remember(url, unknown, false)
    }
    const text = (v: unknown, max: number) => (typeof v === 'string' ? plainText(v, max) : undefined)
    const title = text(o.title, PREVIEW_CAPS.title)
    const author = text(o.author_name, PREVIEW_CAPS.description)
    let image: Stored | null = null
    const thumb = typeof o.thumbnail_url === 'string' ? o.thumbnail_url : undefined
    if (thumb && hostOf(thumb)?.endsWith('ytimg.com')) image = await this.store(thumb, 'image').catch(() => null)
    const link: EmbedMetadata = {
      kind: 'link',
      domain,
      ...(title ? { title } : {}),
      ...(author ? { description: author } : {}),
      site: 'YouTube',
      ...(image ? { image: { media: image.key as never, width: image.width, height: image.height } } : {}),
    }
    const valid = EmbedMetadata.safeParse(link)
    return valid.success ? this.remember(url, valid.data, true) : this.remember(url, unknown, false)
  }

  private async remember(url: string, meta: EmbedMetadata, ok: boolean): Promise<EmbedMetadata> {
    await this.d.db.batch([{
      sql: `INSERT INTO embed_meta (url, ok, json, ts) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT (url) DO UPDATE SET ok = ?2, json = ?3, ts = ?4`,
      params: [url, ok ? 1 : 0, JSON.stringify(meta), this.d.clock.now()],
    }])
    return meta
  }
}
