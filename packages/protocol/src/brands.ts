import { err, ok, type Result } from './result.ts'

declare const brand: unique symbol
export type Brand<T, B extends string> = T & { readonly [brand]: B }

/** A Farcaster ID: a positive safe integer. */
export type Fid = Brand<number, 'Fid'>
/** A message hash: 20 bytes, lowercase 0x-hex on the wire. */
export type CastHash = Brand<`0x${string}`, 'CastHash'>
/** A Farcaster username from the fname registry. */
export type Fname = Brand<string, 'Fname'>
/** A channel's key, such as `base`. */
export type ChannelKey = Brand<string, 'ChannelKey'>
/** A Snapchain event ID, `(block_height << 14) | seq`, unique only within its shard. */
export type EventId = Brand<number, 'EventId'>
/** A Snapchain data shard. Shard 0 holds metadata and isn't polled. */
export type ShardIndex = Brand<1 | 2, 'ShardIndex'>
/** Unix time in seconds. */
export type Timestamp = Brand<number, 'Timestamp'>

export type ParseError = { readonly kind: 'invalid'; readonly type: string; readonly reason: string }
const invalid = (type: string, reason: string): Result<never, ParseError> => err({ kind: 'invalid', type, reason })

export const parseFid = (n: unknown): Result<Fid, ParseError> =>
  typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? ok(n as Fid) : invalid('Fid', 'expected a positive safe integer')

const HASH = /^0x[0-9a-f]{40}$/
export const parseCastHash = (s: unknown): Result<CastHash, ParseError> =>
  typeof s === 'string' && HASH.test(s.toLowerCase()) ? ok(s.toLowerCase() as CastHash) : invalid('CastHash', 'expected 20 bytes of 0x-hex')

// fnames: lowercase letters, digits and hyphens, 1–16 characters, not starting with a hyphen.
// ENS and Basename usernames (`name.eth`, `name.base.eth`) are allowed too.
const FNAME = /^[a-z0-9][a-z0-9-]{0,15}$/
const ENS = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.eth$/
export const parseFname = (s: unknown): Result<Fname, ParseError> =>
  typeof s === 'string' && s.length <= 64 && (FNAME.test(s) || ENS.test(s)) ? ok(s as Fname) : invalid('Fname', 'expected an fname or ENS name')

const CHANNEL = /^[a-z0-9][a-z0-9-]{0,31}$/
export const parseChannelKey = (s: unknown): Result<ChannelKey, ParseError> =>
  typeof s === 'string' && CHANNEL.test(s) ? ok(s as ChannelKey) : invalid('ChannelKey', 'expected 1–32 lowercase letters, digits or hyphens')

export const parseEventId = (n: unknown): Result<EventId, ParseError> =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? ok(n as EventId) : invalid('EventId', 'expected a non-negative safe integer')

export const parseShardIndex = (n: unknown): Result<ShardIndex, ParseError> =>
  n === 1 || n === 2 ? ok(n as ShardIndex) : invalid('ShardIndex', 'expected data shard 1 or 2')

export const parseTimestamp = (n: unknown): Result<Timestamp, ParseError> =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? ok(n as Timestamp) : invalid('Timestamp', 'expected integer Unix seconds')

export const DATA_SHARDS = [1, 2] as unknown as readonly ShardIndex[]
