import { err, ok, type Result } from '@warpstack/protocol'
import { checkUrl, type AddressPolicy } from './address.ts'

// The restricted transport (sealed core): the one way
// the server fetches a URL someone else chose. Everything else in `api` is barred from
// `fetch` by lint, except the fixed-host Snapchain and channel-registry adapters.
//
// - Every URL, the first and each redirect, passes `checkUrl`: https on 443, no IP literals,
//   none of our own hosts.
// - Redirects are followed by hand, at most `maxRedirects`.
// - One deadline covers the whole exchange, redirects included.
// - The body is counted as it streams, after the runtime has decoded any compression, so a
//   small compressed response can't expand past the cap; a declared length over the cap is
//   refused before reading.
// - Nothing of ours is sent: no cookies, credentials or tokens, only Accept and a User-Agent.

export type FetchLimits = { maxBytes: number; timeoutMs: number; maxRedirects: number }

/** Pages: Open Graph tags live in the first part of a page. */
export const PAGE_LIMITS: FetchLimits = { maxBytes: 512 * 1_024, timeoutMs: 3_000, maxRedirects: 3 }
/** Images: proxied and avatar sources, before Cloudflare re-encodes them. */
export const IMAGE_LIMITS: FetchLimits = { maxBytes: 5 * 1_024 * 1_024, timeoutMs: 3_000, maxRedirects: 3 }

/**
 * Untrusted fetches running at once in one isolate. Each buffers its body, so this bounds
 * memory: 4 images at 5 MB stay well inside a Worker's 128 MB. Past it, a fetch is refused
 * at once rather than queued, so a burst can't pile up.
 */
export const MAX_CONCURRENT_FETCHES = 4
let running = 0

export const USER_AGENT = 'WarpstackBot/0.1 (link previews and images for a Farcaster client)'

export type Fetched = { url: string; status: number; contentType: string; bytes: Uint8Array }

export type FetchError =
  | { kind: 'refused'; reason: string }
  | { kind: 'redirects' }
  | { kind: 'status'; status: number }
  | { kind: 'too_large' }
  | { kind: 'timeout' }
  | { kind: 'network'; detail: string }
  /** Too many untrusted fetches already running in this isolate. */
  | { kind: 'busy' }

const REDIRECTS = new Set([301, 302, 303, 307, 308])

export type FetchOptions = {
  policy: AddressPolicy
  limits: FetchLimits
  /** The Accept header: what kind of response is wanted. */
  accept: string
  /** The runtime's fetch; injected so tests can play hostile servers. */
  fetcher?: typeof fetch
}

export const untrustedFetch = async (raw: string, o: FetchOptions): Promise<Result<Fetched, FetchError>> => {
  if (running >= MAX_CONCURRENT_FETCHES) return err({ kind: 'busy' })
  running++
  try {
    return await fetchOnce(raw, o)
  } finally {
    running--
  }
}

const fetchOnce = async (raw: string, o: FetchOptions): Promise<Result<Fetched, FetchError>> => {
  const f = o.fetcher ?? ((input, init) => fetch(input, init))
  const signal = AbortSignal.timeout(o.limits.timeoutMs)
  let next = raw
  try {
    for (let hop = 0; ; hop++) {
      const checked = checkUrl(next, o.policy)
      if (!checked.ok) return err({ kind: 'refused', reason: checked.error })
      const url = checked.value.href
      const res = await f(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: o.accept, 'user-agent': USER_AGENT },
        signal,
      })
      if (REDIRECTS.has(res.status)) {
        await res.body?.cancel().catch(() => {})
        const location = res.headers.get('location')
        if (!location || hop >= o.limits.maxRedirects) return err({ kind: 'redirects' })
        try {
          next = new URL(location, url).href
        } catch {
          return err({ kind: 'refused', reason: 'bad redirect' })
        }
        continue
      }
      if (res.status < 200 || res.status > 299) {
        await res.body?.cancel().catch(() => {})
        return err({ kind: 'status', status: res.status })
      }
      const declared = Number(res.headers.get('content-length') ?? NaN)
      if (Number.isFinite(declared) && declared > o.limits.maxBytes) {
        await res.body?.cancel().catch(() => {})
        return err({ kind: 'too_large' })
      }
      const bytes = await readCapped(res, o.limits.maxBytes)
      if (!bytes) return err({ kind: 'too_large' })
      return ok({ url, status: res.status, contentType: (res.headers.get('content-type') ?? '').toLowerCase().slice(0, 200), bytes })
    }
  } catch (e) {
    if (signal.aborted) return err({ kind: 'timeout' })
    return err({ kind: 'network', detail: String(e).slice(0, 200) })
  }
}

/** The body, or null as soon as it passes `max` bytes. */
const readCapped = async (res: Response, max: number): Promise<Uint8Array | null> => {
  if (!res.body) return new Uint8Array()
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}
