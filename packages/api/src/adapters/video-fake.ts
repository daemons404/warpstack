import { err, ok, type Result } from '@warpstack/protocol'
import type { UpstreamError, VideoHost, VideoState } from '../ports.ts'

// An in-memory Stream for tests and local runs: uploads exist once created, and a test moves
// them along with `finish` or `fail`.

export const FAKE_STREAM_HOST = 'customer-fake.cloudflarestream.com'

export class FakeVideoHost implements VideoHost {
  readonly videos = new Map<string, VideoState & { creator: string; maxSeconds: number; expiresAt: number }>()
  down = false
  private next = 0

  async createUpload(opts: { maxSeconds: number; creator: string; expiresAt: number }): Promise<Result<{ id: string; uploadUrl: string }, UpstreamError>> {
    if (this.down) return err({ kind: 'unavailable', detail: 'fake stream is down' })
    const id = (this.next++).toString(16).padStart(32, '0')
    this.videos.set(id, { state: 'processing', ...opts })
    return ok({ id, uploadUrl: `https://upload.fake.cloudflarestream.com/${id}` })
  }

  async status(id: string): Promise<Result<VideoState, UpstreamError>> {
    if (this.down) return err({ kind: 'unavailable', detail: 'fake stream is down' })
    const v = this.videos.get(id)
    if (!v) return err({ kind: 'bad_response', detail: 'no such video' })
    const { creator: _c, maxSeconds: _m, expiresAt: _e, ...state } = v
    return ok(state)
  }

  finish(id: string, extra: { width?: number; height?: number; duration?: number } = {}): string {
    const v = this.videos.get(id)
    if (!v) throw new Error(`no video ${id}`)
    const hls = `https://${FAKE_STREAM_HOST}/${id}/manifest/video.m3u8`
    this.videos.set(id, { state: 'ready', hls, thumbnail: `https://${FAKE_STREAM_HOST}/${id}/thumbnails/thumbnail.jpg`, ...extra, creator: v.creator, maxSeconds: v.maxSeconds, expiresAt: v.expiresAt })
    return hls
  }

  fail(id: string, reason: string): void {
    const v = this.videos.get(id)
    if (!v) throw new Error(`no video ${id}`)
    this.videos.set(id, { state: 'failed', reason, creator: v.creator, maxSeconds: v.maxSeconds, expiresAt: v.expiresAt })
  }
}
