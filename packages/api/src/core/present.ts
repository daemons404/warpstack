import {
  Address, Cast, CastHash, ChannelKey, Fname, HttpsUrl, MediaKey, ParentUrl, QuotedCast, utf8,
  type Channel, type QuotedCast as QuotedCastT, type User, type UserSummary,
} from '@warpstack/contract'
import type { z } from 'zod'
import { channelKeyOfUrl } from './channels.ts'
import type { CastRow, ChannelDbRow, UserRow } from './rows.ts'

// Index rows to contract entities. Pure; the read service gathers the rows. Every field is
// checked with the contract's own schema, and an optional field that fails is dropped, so
// one user's malformed profile can never make a page fail its output validation. A cast
// that still fails is dropped from the page by the read service (`keepValid`).

const valid = <T>(schema: z.ZodType<T, unknown>, v: unknown): T | undefined => {
  if (v === null || v === undefined || v === '') return undefined
  const r = schema.safeParse(v)
  return r.success ? r.data : undefined
}

const DISPLAY = utf8(64)
const BIO = utf8(256)
const LOCATION = utf8(64)
const CHANNEL_NAME = utf8(256)
const CHANNEL_DESCRIPTION = utf8(1_024)

/** Truncates to a UTF-8 byte budget on a code point boundary, so long free text shows instead of vanishing. */
export const clampUtf8 = (s: string, maxBytes: number): string => {
  const enc = new TextEncoder()
  if (enc.encode(s).length <= maxBytes) return s
  let out = ''
  let n = 0
  for (const ch of s) {
    const b = enc.encode(ch).length
    if (n + b > maxBytes - 3) break
    out += ch
    n += b
  }
  return `${out}…`
}

const text = (s: string | null | undefined, schema: z.ZodType<string, unknown>, maxBytes: number) =>
  valid(schema, s ? clampUtf8(s, maxBytes) : s)

const pfpOf = (u: UserRow | undefined): { pfp?: UserSummary['pfp'] } => {
  // `pending`: being stored right now, under a key fixed by its URL; the app retries briefly.
  const key = u?.pfp_status === 'ok' || u?.pfp_status === 'pending' ? valid(MediaKey, u.pfp_key) : undefined
  return key ? { pfp: key as UserSummary['pfp'] } : {}
}

export const userSummaryOf = (fid: number, u: UserRow | undefined): UserSummary => ({
  fid: fid as UserSummary['fid'],
  username: valid(Fname, u?.username),
  displayName: text(u?.display, DISPLAY, 64),
  // Only an avatar the media store holds or is storing; never the profile's remote URL.
  ...pfpOf(u),
  pro: u?.pro === 1,
})

type Verification = User['verifications'][number]

const verificationsOf = (raw: string | null | undefined): Verification[] => {
  try {
    const v = JSON.parse(raw ?? '[]') as unknown
    if (!Array.isArray(v)) return []
    return v.flatMap((x): Verification[] => {
      if (typeof x === 'string') return valid(Address, x) ? [{ address: x, protocol: 'ethereum' }] : []
      if (x && typeof x === 'object' && typeof x.address === 'string' && x.address.length <= 64) {
        return [{ address: x.address, protocol: x.protocol === 'solana' ? 'solana' : 'ethereum' }]
      }
      return []
    }).slice(0, 50)
  } catch {
    return []
  }
}

export const userOf = (fid: number, u: UserRow | undefined): User => ({
  ...userSummaryOf(fid, u),
  bio: text(u?.bio, BIO, 256),
  url: valid(HttpsUrl, u?.url),
  location: text(u?.location, LOCATION, 64),
  primaryAddress: valid(Address, u?.primary_addr),
  verifications: verificationsOf(u?.verified),
  followers: u?.followers ?? undefined,
  following: u?.following ?? undefined,
  countsExact: u ? u.counts_bounded !== 1 : false,
})

export const channelOf = (r: ChannelDbRow): Channel | null => {
  const key = valid(ChannelKey, r.key)
  const url = valid(ParentUrl, r.url)
  if (!key || !url) return null
  let moderators: number[] = []
  try {
    moderators = (JSON.parse(r.moderators) as unknown[]).filter((n): n is number => Number.isSafeInteger(n) && (n as number) > 0).slice(0, 50)
  } catch {
    // keep none
  }
  return {
    key,
    name: text(r.name, CHANNEL_NAME, 256) ?? key,
    description: text(r.description, CHANNEL_DESCRIPTION, 1_024),
    url,
    moderators: moderators as Channel['moderators'],
    followers: r.follower_count ?? undefined,
    // Only an image the media store holds or is storing; never the registry's remote URL.
    ...(r.image_status === 'ok' || r.image_status === 'pending' ? { image: valid(MediaKey, r.image_key) as Channel['image'] } : {}),
  }
}

export type Counts = { likes: number; recasts: number; replies: number; exact: boolean }

export type CastContext = {
  users: Map<number, UserRow>
  channelKeys: Map<string, string>
  counts: Map<string, Counts>
  /** Quoted casts by hash; `null` when deleted or unreadable. Absent hashes aren't hydrated. */
  quotes: Map<string, QuotedCastT | null>
}

type RawEmbed = { kind: 'url'; url: string } | { kind: 'cast'; cast: { fid: number; hash: string } }

export const embedsOf = (row: CastRow) => {
  try {
    return (JSON.parse(row.embeds) as RawEmbed[]).slice(0, 4)
  } catch {
    return []
  }
}

const mentionsOf = (row: CastRow, ctx: CastContext) => {
  try {
    const bytes = new TextEncoder().encode(row.text).length
    return (JSON.parse(row.mentions) as { fid: number; position: number }[])
      .filter(m => Number.isSafeInteger(m.fid) && m.fid > 0 && Number.isSafeInteger(m.position) && m.position >= 0 && m.position <= bytes)
      .slice(0, 10)
      .map(m => ({ fid: m.fid, pos: m.position, username: valid(Fname, ctx.users.get(m.fid)?.username) }))
  } catch {
    return []
  }
}

const parentOf = (row: CastRow, ctx: CastContext) => {
  if (row.parent_hash && row.parent_fid && valid(CastHash, row.parent_hash)) {
    return { kind: 'cast' as const, ref: { fid: row.parent_fid, hash: row.parent_hash } }
  }
  if (!row.channel) return undefined
  const key = valid(ChannelKey, ctx.channelKeys.get(row.channel) ?? channelKeyOfUrl(row.channel))
  if (key && valid(ParentUrl, row.channel)) return { kind: 'channel' as const, key, url: row.channel }
  const url = valid(HttpsUrl, row.channel)
  return url ? { kind: 'url' as const, url } : undefined
}

const baseOf = (row: CastRow, ctx: CastContext) => ({
  fid: row.fid,
  hash: row.hash,
  ts: row.ts,
  type: row.type,
  text: row.text,
  mentions: mentionsOf(row, ctx),
  parent: parentOf(row, ctx),
  counts: ctx.counts.get(row.hash) ?? { likes: 0, recasts: 0, replies: 0, exact: false },
  author: userSummaryOf(row.fid, ctx.users.get(row.fid)),
})

/** A cast's quote, one level deep: its own embeds are references only. */
export const quotedOf = (row: CastRow, ctx: CastContext): QuotedCastT | null => {
  const embeds = embedsOf(row).flatMap((e): unknown[] =>
    e.kind === 'cast' ? (valid(CastHash, e.cast.hash) ? [{ kind: 'cast', ref: e.cast }] : [])
    : valid(HttpsUrl, e.url) ? [{ kind: 'url', url: e.url }] : [])
  const r = QuotedCast.safeParse({ ...baseOf(row, ctx), embeds })
  return r.success ? r.data : null
}

export const castOf = (row: CastRow, ctx: CastContext): Cast | null => {
  const embeds = embedsOf(row).flatMap((e): unknown[] => {
    if (e.kind === 'cast') {
      if (!valid(CastHash, e.cast.hash)) return []
      return [{ kind: 'cast', ref: e.cast, cast: ctx.quotes.get(e.cast.hash) ?? null }]
    }
    return valid(HttpsUrl, e.url) ? [{ kind: 'url', url: e.url }] : []
  })
  const r = Cast.safeParse({ ...baseOf(row, ctx), embeds })
  return r.success ? r.data : null
}
