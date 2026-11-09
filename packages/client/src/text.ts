import type { Cast } from '@warpstack/contract'

// Cast text as segments any shell can draw. Mentions sit at UTF-8 byte offsets in the
// text, so positions are applied on the encoded bytes, not on UTF-16 string indexes.

export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; fid: number; username?: string | undefined }
  | { kind: 'link'; url: string; text: string }
  | { kind: 'channel'; key: string }

// A URL ends before whitespace, quotes of any kind, and trailing punctuation, including
// Unicode closing marks. A closing parenthesis stays only when it balances one in the URL.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`“”‘’«»]+/g
const TRAILING = /[.,;:!?…。、)\]}»”’]+$/u
// A channel reference is `/key` at a word boundary, not a path like `/usr/bin` or `/a/b`.
const CHANNEL_RE = /(^|\s)\/([a-z0-9][a-z0-9-]{0,31})(?![\w/-])/g

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const castSegments = (cast: Pick<Cast, 'text' | 'mentions'>): Segment[] => {
  const bytes = encoder.encode(cast.text)
  const mentions = [...cast.mentions]
    .filter(m => m.pos >= 0 && m.pos <= bytes.length)
    .sort((a, b) => a.pos - b.pos)
  const out: Segment[] = []
  let at = 0
  for (const m of mentions) {
    out.push(...inline(decoder.decode(bytes.slice(at, m.pos))))
    out.push({ kind: 'mention', fid: m.fid, username: m.username })
    at = m.pos
  }
  out.push(...inline(decoder.decode(bytes.slice(at))))
  return out.filter(s => s.kind !== 'text' || s.text.length > 0)
}

/** Links and channel references within a run of plain text. Only http(s) URLs become links. */
const inline = (text: string): Segment[] => {
  const out: Segment[] = []
  const matches: { start: number; end: number; seg: Segment }[] = []
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0])
    matches.push({ start: m.index, end: m.index + url.length, seg: { kind: 'link', url, text: shorten(url) } })
  }
  for (const m of text.matchAll(CHANNEL_RE)) {
    const start = m.index + (m[1]?.length ?? 0)
    if (matches.some(x => start >= x.start && start < x.end)) continue
    matches.push({ start, end: start + 1 + (m[2]?.length ?? 0), seg: { kind: 'channel', key: m[2] ?? '' } })
  }
  matches.sort((a, b) => a.start - b.start)
  let at = 0
  for (const m of matches) {
    if (m.start < at) continue
    out.push({ kind: 'text', text: text.slice(at, m.start) })
    out.push(m.seg)
    at = m.end
  }
  out.push({ kind: 'text', text: text.slice(at) })
  return out
}

const trimUrl = (raw: string): string => {
  let url = raw.replace(TRAILING, '')
  // Put back closing parentheses the URL itself opened, as in Wikipedia links.
  const rest = raw.slice(url.length)
  for (const ch of rest) {
    if (ch !== ')') break
    const open = (url.match(/\(/g) ?? []).length
    const close = (url.match(/\)/g) ?? []).length
    if (open > close) url += ')'
    else break
  }
  return url
}

const shorten = (url: string) => {
  const s = url.replace(/^https?:\/\/(www\.)?/, '')
  return s.length > 40 ? `${s.slice(0, 39)}…` : s
}

/** "now", "5m", "3h", "2d", then a date. */
export const relativeTime = (ts: number, now: number): string => {
  const d = Math.max(0, now - ts)
  if (d < 60) return 'now'
  if (d < 3_600) return `${Math.floor(d / 60)}m`
  if (d < 86_400) return `${Math.floor(d / 3_600)}h`
  if (d < 7 * 86_400) return `${Math.floor(d / 86_400)}d`
  const date = new Date(ts * 1_000)
  const sameYear = date.getUTCFullYear() === new Date(now * 1_000).getUTCFullYear()
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}
