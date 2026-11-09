import { parseCastHash, parseChannelKey, parseFid, parseFname, type CastHash, type ChannelKey, type Fid, type Fname } from '@warpstack/protocol'

// Typed links and route params. Canonical URLs are FID-based;
// `/{username}` is an alias that resolves to the profile. Screens never build paths by hand.

export const routes = {
  home: () => '/' as const,
  channel: (key: string) => `/channel/${encodeURIComponent(key)}` as const,
  profile: (fid: number) => `/profile/${fid}` as const,
  thread: (ref: { fid: number; hash: string }) => `/cast/${ref.fid}/${ref.hash}` as const,
  signIn: () => '/sign-in' as const,
  notifications: () => '/notifications' as const,
  settings: () => '/settings' as const,
  /** The composer, optionally replying to or quoting a cast, or posting in a channel. */
  compose: (o: { reply?: { fid: number; hash: string }; quote?: { fid: number; hash: string }; channel?: string } = {}) => {
    const q = new URLSearchParams()
    if (o.reply) q.set('reply', `${o.reply.fid}:${o.reply.hash}`)
    if (o.quote) q.set('quote', `${o.quote.fid}:${o.quote.hash}`)
    if (o.channel) q.set('channel', o.channel)
    const s = q.toString()
    return (s ? `/compose?${s}` : '/compose') as `/compose${string}`
  },
}

/** Route params arrive as strings; only canonical spellings parse, so one thing has one URL. */
export const params = {
  fid: (s: unknown): Fid | null => {
    if (typeof s !== 'string' || !/^[1-9]\d{0,15}$/.test(s)) return null
    const r = parseFid(Number(s))
    return r.ok ? r.value : null
  },
  hash: (s: unknown): CastHash | null => {
    const r = typeof s === 'string' && s === s.toLowerCase() ? parseCastHash(s) : null
    return r?.ok ? r.value : null
  },
  channel: (s: unknown): ChannelKey | null => {
    const r = parseChannelKey(s)
    return r.ok ? r.value : null
  },
  /** `fid:hash`, as `routes.compose` writes a cast reference. */
  castRef: (s: unknown): { fid: Fid; hash: CastHash } | null => {
    if (typeof s !== 'string') return null
    const [fid, hash, ...rest] = s.split(':')
    const f = params.fid(fid)
    const h = params.hash(hash)
    return f && h && !rest.length ? { fid: f, hash: h } : null
  },
  username: (s: unknown): Fname | null => {
    const r = typeof s === 'string' ? parseFname(s.toLowerCase().replace(/^@/, '')) : null
    return r?.ok ? r.value : null
  },
}
