import type { CastHash as CastHashT, ChannelKey as ChannelKeyT, Fid as FidT, Fname as FnameT, Timestamp as TimestampT } from '@warpstack/protocol'
import { z } from 'zod'

// Behavior must be identical on Workers, Node and Hermes, where `new Function` isn't allowed.
z.config({ jitless: true })

// Wire types: every contract type is a plain JSON value
// with a brand, in a small dialect. No `.transform`, `.refine`, `.default` or `.catch`, so
// every rule a schema enforces is visible in its JSON Schema and the compatibility check
// can't miss a change. The only named check is `utf8`, which carries `x-utf8MaxBytes`.
// The brands come from `protocol`; the patterns here match its parsers, and a test checks
// that they agree.

const brand = <T, I>(schema: z.ZodType<I, I>): z.ZodType<T, I> => schema as unknown as z.ZodType<T, I>

/** A JSON number, a positive safe integer. Path and query values are coerced by the handler's smart coercion. */
export const Fid = brand<FidT, number>(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER))
/** `0x` + 40 lowercase hex. */
export const CastHash = brand<CastHashT, string>(z.string().regex(/^0x[0-9a-f]{40}$/))
/** An fname, or an ENS or Basename username (`name.eth`, `name.base.eth`). */
export const Fname = brand<FnameT, string>(z.string().max(64)
  .regex(/^(?:[a-z0-9][a-z0-9-]{0,15}|[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*\.eth)$/))
export const ChannelKey = brand<ChannelKeyT, string>(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/))
/** Integer Unix seconds. Farcaster time stays inside `protocol`. */
export const Timestamp = brand<TimestampT, number>(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))
export const Count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
/** The index revision a response was read at: monotonic, so the client merges only newer snapshots. */
export const Rev = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).brand<'Rev'>()
export type Rev = z.infer<typeof Rev>
export const Address = z.string().regex(/^0x[0-9a-f]{40}$/)
/** Requires the literal `https://`: URL parsers accept `https:/x` and `https:x`, which browsers rewrite. */
export const HttpsUrl = z.url({ protocol: /^https$/ }).max(2_048).regex(/^https:\/\/[^/\\]/)
/** An http(s) URL, for deployment origins, which are http in local development. */
export const OriginUrl = z.url({ protocol: /^https?$/ }).max(2_048).regex(/^https?:\/\/[^/\\]/)
/** A cast's parent URL: any URI up to 256 bytes, such as `chain://eip155:1/erc721:0x…`. */
export const ParentUrl = z.string().min(1).max(256)
/**
 * An image on the deployment's media origin; the client builds `https://{origins.media}/{key}`.
 * No image field can hold a URL, so a device can't be pointed at an attacker's host.
 */
export const MediaKey = z.string().regex(/^[a-z0-9][a-z0-9/._-]{0,511}$/).brand<'MediaKey'>()
export const SemVer = z.string().regex(/^\d+\.\d+\.\d+$/)

/** Counts UTF-8 bytes; `z.string().max` counts UTF-16 units, the wrong limit for cast text. */
export const utf8 = (maxBytes: number) =>
  z.string().max(maxBytes)
    .check(z.refine(s => new TextEncoder().encode(s).length <= maxBytes, `at most ${maxBytes} UTF-8 bytes`))
    .meta({ 'x-utf8MaxBytes': maxBytes })

declare const unknownBrand: unique symbol
/** A value a newer server added, which this client doesn't know. */
export type Unknown = string & { readonly [unknownBrand]: 'Unknown' }

const alternation = (values: readonly string[]) => values.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')

/**
 * Display-only enums are open: any other value parses as `Unknown`, with no transform, so a
 * newer server can add one and an old app renders a generic row. Security-relevant enums use
 * a plain `z.enum`, which is closed and fails on an unknown value.
 */
export const openEnum = <const T extends readonly [string, ...string[]]>(values: T) =>
  z.union([z.enum(values), z.string().max(64).regex(new RegExp(`^(?!(?:${alternation(values)})$)`)) as unknown as z.ZodType<Unknown, string>])

/**
 * An open discriminated union: an object whose `kind` this client doesn't know parses as
 * `{ kind: Unknown }`. A known kind must match its variant exactly; it never falls through.
 */
export const openUnion = <const V extends readonly [z.ZodObject<{ kind: z.ZodLiteral<string> }>, ...z.ZodObject<{ kind: z.ZodLiteral<string> }>[]]>(variants: V) => {
  const known = variants.map(v => v.shape.kind.value as string)
  const other = z.object({ kind: z.string().max(64).regex(new RegExp(`^(?!(?:${alternation(known)})$)`)) as unknown as z.ZodType<Unknown, string> })
  return z.union([...variants, other] as unknown as [V[number], typeof other])
}
