import type { Embed } from '@warpstack/contract'

/** How a shell should draw an embed, from its URL alone until `embed.metadata` ships. Links always show their host. */
export type EmbedView =
  | { kind: 'image'; url: string; host: string }
  | { kind: 'video'; url: string; host: string }
  | { kind: 'link'; url: string; host: string }
  | { kind: 'cast'; ref: { fid: number; hash: string }; cast: Extract<Embed, { kind: 'cast' }>['cast'] }

const IMAGE_HOSTS = new Set(['imagedelivery.net', 'i.imgur.com'])
const VIDEO_HOSTS = new Set(['stream.warpcast.com', 'stream.farcaster.xyz'])

export const embedView = (e: Embed): EmbedView | null => {
  if (e.kind === 'cast' && 'ref' in e) return { kind: 'cast', ref: e.ref, cast: 'cast' in e ? e.cast : null }
  if (e.kind !== 'url' || !('url' in e)) return null
  let u: URL
  try {
    u = new URL(e.url)
  } catch {
    return null
  }
  const host = u.host
  // Classified by host and path only: a query string can't make a link look like an image.
  if (IMAGE_HOSTS.has(host) || /\.(png|jpe?g|gif|webp|avif)$/i.test(u.pathname)) return { kind: 'image', url: e.url, host }
  if (VIDEO_HOSTS.has(host) || /\.(mp4|m3u8|webm|mov)$/i.test(u.pathname)) return { kind: 'video', url: e.url, host }
  return { kind: 'link', url: e.url, host }
}
