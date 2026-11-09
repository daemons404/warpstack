// Link previews from a fetched page (sealed core; hostile content in previews).
// Only a handful of Open Graph and Twitter fields and the <title> are read, from the page's
// head, and each becomes plain text: entities decoded, tags and control characters removed,
// whitespace collapsed, length capped. No HTML is kept or passed on, and the preview image is
// only a URL here: it goes through the image fetcher like any other before anyone sees it.
//
// The scan is linear: it walks the text with indexOf, and the one regular expression runs on a
// single tag of at most `MAX_TAG` characters, so a hostile page can't make it backtrack.

export type Preview = { title?: string; description?: string; site?: string; image?: string }

export const PREVIEW_CAPS = { title: 200, description: 400, site: 80 } as const
const MAX_TAG = 4_096
const MAX_TAGS = 400

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', '#39': '\'' }

const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
  const k = e.toLowerCase()
  if (k.startsWith('#x')) return codePoint(parseInt(k.slice(2), 16))
  if (k.startsWith('#')) return codePoint(parseInt(k.slice(1), 10))
  return ENTITIES[k] ?? m
})

const codePoint = (n: number) => (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '')

/**
 * Control characters (C0 and C1), zero-width and direction marks, bidi overrides and isolates,
 * and the byte-order mark: characters that hide or reorder text, so a preview can't make a
 * title read differently from what it says.
 */
const invisible = (c: number) =>
  c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e)
  || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff

/** Plain text: decoded, tags and control characters gone, whitespace collapsed, capped. */
export const plainText = (raw: string, max: number): string | undefined => {
  const s = decodeEntities(raw)
    .replace(/<[^<>]{0,4096}>/g, ' ')
    .replace(/./gsu, ch => (invisible(ch.codePointAt(0)!) ? ' ' : ch))
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return undefined
  return [...s].length > max ? `${[...s].slice(0, max - 1).join('')}…` : s
}

const ATTR = /([a-z][a-z0-9:_-]{0,40})\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi

const attributes = (tag: string): Map<string, string> => {
  const out = new Map<string, string>()
  for (const m of tag.matchAll(ATTR)) {
    const name = m[1]!.toLowerCase()
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? '')
  }
  return out
}

/**
 * Where a tag that starts at `from` ends: the first `>` outside quotes, so a `>` inside an
 * attribute value doesn't cut the tag short. -1 if there's none within `MAX_TAG` characters.
 */
const tagEnd = (html: string, from: number): number => {
  let quote = ''
  const stop = Math.min(html.length, from + MAX_TAG)
  for (let i = from; i < stop; i++) {
    const ch = html[i]!
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === '\'') {
      quote = ch
    } else if (ch === '>') {
      return i
    }
  }
  return -1
}

/** The preview fields of an HTML page, from its head. */
export const readPreview = (html: string): Preview => {
  const lower = html.toLowerCase()
  const headEnd = lower.indexOf('</head')
  const end = headEnd === -1 ? html.length : headEnd
  const meta = new Map<string, string>()
  let title: string | undefined
  let tags = 0
  for (let i = lower.indexOf('<', 0); i !== -1 && i < end && tags < MAX_TAGS; i = lower.indexOf('<', i + 1)) {
    if (lower.startsWith('<meta', i)) {
      tags++
      const close = tagEnd(html, i)
      if (close === -1) continue
      const a = attributes(html.slice(i + 5, close))
      const key = (a.get('property') ?? a.get('name') ?? '').toLowerCase()
      const content = a.get('content')
      if (key && content !== undefined && !meta.has(key)) meta.set(key, content)
    } else if (title === undefined && lower.startsWith('<title', i)) {
      const open = tagEnd(html, i)
      const close = open === -1 ? -1 : lower.indexOf('</title', open)
      if (open !== -1 && close !== -1 && close - open <= MAX_TAG) title = html.slice(open + 1, close)
    }
  }
  const pick = (...keys: string[]) => keys.map(k => meta.get(k)).find(v => v !== undefined && v.trim() !== '')
  const image = pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src')
  const out: Preview = {}
  const t = plainText(pick('og:title', 'twitter:title') ?? title ?? '', PREVIEW_CAPS.title)
  const d = plainText(pick('og:description', 'twitter:description', 'description') ?? '', PREVIEW_CAPS.description)
  const s = plainText(pick('og:site_name') ?? '', PREVIEW_CAPS.site)
  if (t) out.title = t
  if (d) out.description = d
  if (s) out.site = s
  if (image) {
    const decoded = decodeEntities(image.trim())
    if (decoded.length <= 2_048) out.image = decoded
  }
  return out
}
