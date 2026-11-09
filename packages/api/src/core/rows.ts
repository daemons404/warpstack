import { fromFarcasterTime, type Timestamp } from '@warpstack/protocol'
import type { InboundStep } from './inbound.ts'
import type { OwnMessage } from './own.ts'
import { MT, type Message } from './snapchain-types.ts'

// Index rows, as the fold writes them and the read path reads them. Hashes are lowercase
// 0x-hex TEXT rather than BLOB: it keeps JSON parameters and json_each simple, at about
// twice the key size (noted in the M1 proposal's deviations).

export type CastRow = {
  hash: string
  fid: number
  ts: number
  reply: 0 | 1
  parent_hash: string | null
  parent_fid: number | null
  /** The parent URL of a top-level channel cast. */
  channel: string | null
  type: 'cast' | 'long' | 'tenK'
  text: string
  /** JSON: `Embed[]` in the contract's shape. */
  embeds: string
  /** JSON: `{ fid, position }[]`. */
  mentions: string
}

export type RecastRow = { hash: string; fid: number; ts: number; target_hash: string; target_fid: number }

export type UserField = 'username' | 'display' | 'pfp' | 'bio' | 'url' | 'location' | 'banner' | 'primary_addr'

export type ChannelRow = {
  key: string
  url: string
  name: string
  description: string | null
  image: string | null
  moderators: number[]
  follower_count: number | null
}

/** What one event page does to the index, as data. The adapter turns it into one transaction. */
export type IndexOps = {
  castsPut: CastRow[]
  castsDel: string[]
  recastsPut: RecastRow[]
  recastsDel: string[]
  /** Coalesced per target within the page. */
  counts: { hash: string; likes: number; recasts: number; replies: number; ts: number }[]
  /** The last value per (fid, field) within the page. */
  users: { fid: number; field: UserField; value: string | null; ts: number }[]
  /**
   * Every own-history step in the page, for every FID. The batch keeps only members' steps
   * (`deliveries`), in the same transaction as the cursor, so none is lost or doubled.
   */
  /**
   * Steps for members' user objects, keyed by (fid, event, seq): their own history (`add`,
   * `remove`) and notifications aimed at them (`notify`, `unnotify`).
   */
  own: { event_id: number; seq: number; fid: number; p: { op: 'add' | 'remove'; msg: OwnMessage } | InboundStep }[]
}

export const emptyOps = (): IndexOps => ({ castsPut: [], castsDel: [], recastsPut: [], recastsDel: [], counts: [], users: [], own: [] })

const CAST_TYPES: Record<string, CastRow['type']> = { CAST: 'cast', LONG_CAST: 'long', TEN_K_CAST: 'tenK' }

export const castRowOf = (m: Message): CastRow | null => {
  const body = m.data.castAddBody
  if (m.data.type !== MT.castAdd || !body) return null
  const embeds = body.embeds.flatMap((e): unknown[] =>
    e.castId ? [{ kind: 'cast', cast: { fid: e.castId.fid, hash: e.castId.hash } }]
    : e.url ? [{ kind: 'url', url: e.url }]
    : [])
  const mentions = body.mentions.map((fid, i) => ({ fid, position: body.mentionsPositions[i] ?? 0 }))
  return {
    hash: m.hash,
    fid: m.data.fid,
    ts: fromFarcasterTime(m.data.timestamp),
    reply: body.parentCastId ? 1 : 0,
    parent_hash: body.parentCastId?.hash ?? null,
    parent_fid: body.parentCastId?.fid ?? null,
    channel: !body.parentCastId && body.parentUrl ? body.parentUrl : null,
    type: CAST_TYPES[body.type ?? 'CAST'] ?? 'cast',
    text: body.text,
    embeds: JSON.stringify(embeds),
    mentions: JSON.stringify(mentions),
  }
}

const USER_FIELDS: Record<string, UserField> = {
  USER_DATA_TYPE_USERNAME: 'username',
  USER_DATA_TYPE_DISPLAY: 'display',
  USER_DATA_TYPE_PFP: 'pfp',
  USER_DATA_TYPE_BIO: 'bio',
  USER_DATA_TYPE_URL: 'url',
  USER_DATA_TYPE_LOCATION: 'location',
  USER_DATA_TYPE_BANNER: 'banner',
  USER_DATA_PRIMARY_ADDRESS_ETHEREUM: 'primary_addr',
}

export const userFieldOf = (m: Message): { field: UserField; value: string | null; ts: Timestamp } | null => {
  const body = m.data.userDataBody
  const field = body && USER_FIELDS[body.type]
  if (m.data.type !== MT.userDataAdd || !body || !field) return null
  const trimmed = body.value.trim()
  const value = trimmed === '' ? null
    : field === 'username' || field === 'primary_addr' ? trimmed.toLowerCase()
    : trimmed
  return { field, value, ts: fromFarcasterTime(m.data.timestamp) }
}

// Rows as the read path sees them.

export type CountedCastRow = CastRow & { state: number; likes: number | null; recasts: number | null; replies: number | null }

export type UserRow = {
  fid: number
  username: string | null
  display: string | null
  pfp: string | null
  bio: string | null
  url: string | null
  location: string | null
  banner: string | null
  primary_addr: string | null
  verified: string | null
  pro: number
  followers: number | null
  following: number | null
  counts_bounded: number
  counts_ts: number | null
  /** The stored avatar for `pfp`, from media_sources (`ok`, `failed`), or `pending` while this request asks for it. */
  pfp_key?: string | null
  pfp_status?: string | null
  pfp_ts?: number | null
  complete: number
  updated_ts: number
}

export type ChannelDbRow = Omit<ChannelRow, 'moderators'> & {
  moderators: string
  /** The stored image for `image`, from media_sources (`ok`, `failed`), or `pending` while a response asks for it. */
  image_key?: string | null
  image_status?: string | null
  image_ts?: number | null
}

