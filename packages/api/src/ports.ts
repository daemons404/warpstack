import type { CastHash, EventId, Fid, Result, ShardIndex, Timestamp } from '@warpstack/protocol'
import type { CastId, HubEvent, Message } from './core/snapchain-types.ts'
import type { ChannelRow, IndexOps } from './core/rows.ts'

// Every Cloudflare service and upstream sits behind a port with an in-memory fake that
// passes the same contract suite (overview, Ports).

export type UpstreamError =
  | { kind: 'unavailable'; detail: string }
  | { kind: 'bad_response'; detail: string }

/** The node refused a submitted message, with its reason. */
export type SubmitError = UpstreamError | { kind: 'rejected'; detail: string }

/** A key from the node's unified signer list, times in Unix seconds. */
export type SignerInfo = {
  key: string
  source: 'onchain' | 'gasless'
  scopes: number[]
  requestFid?: number | undefined
  addedAt?: number | undefined
  lastUsedAt?: number | undefined
  expiresAt?: number | undefined
}
export type Signers = { keys: SignerInfo[]; userNonce: number; requesterNonces: Map<number, number> }

export type EventPage = { events: HubEvent[]; skipped: number; lastId: EventId | null }
export type StorageLimits = { pro: boolean; stores: { type: string; used: number; limit: number }[] }

export type PageRequest = { token?: string | undefined; size: number; reverse: boolean }
export type MessagePage = { messages: Message[]; next?: string | undefined }
export type UpstreamResult<T> = Promise<Result<T, UpstreamError>>

/** Snapchain's own HTTP API, one node by URL in M1 (the pool is config-shaped). */
export interface Snapchain {
  /** A page of events. Events that fail to parse are counted in `skipped` and left out. */
  events(shard: ShardIndex, from: EventId, pageSize: number): UpstreamResult<EventPage>
  /** The newest block height per data shard. */
  heads(): UpstreamResult<Map<ShardIndex, number>>
  castById(fid: Fid, hash: CastHash): UpstreamResult<Message | null>
  castsByFid(fid: Fid, page: PageRequest): UpstreamResult<MessagePage>
  castsByParent(parent: CastId, page: PageRequest): UpstreamResult<MessagePage>
  reactionsByCast(cast: CastId, kind: 'like' | 'recast', page: PageRequest): UpstreamResult<MessagePage>
  /** The FID's follows, or its protocol blocks with `type: 'block'`. */
  linksByFid(fid: Fid, page: PageRequest, type?: 'follow' | 'block'): UpstreamResult<MessagePage>
  linksByTarget(fid: Fid, page: PageRequest): UpstreamResult<MessagePage>
  userData(fid: Fid): UpstreamResult<Message[]>
  verifications(fid: Fid): UpstreamResult<Message[]>
  storageLimits(fid: Fid): UpstreamResult<StorageLimits>
  fidByUsername(name: string): UpstreamResult<Fid | null>
  castsByMention(fid: Fid, page: PageRequest): UpstreamResult<MessagePage>
  reactionsByFid(fid: Fid, kind: 'like' | 'recast', page: PageRequest): UpstreamResult<MessagePage>
  /** Keys and gasless nonces; `requesterFids` adds their app nonces. */
  signers(fid: Fid, requesterFids: readonly Fid[]): UpstreamResult<Signers>
  /** The FID's current custody address, lowercase hex; `null` when the FID doesn't exist. */
  custodyOf(fid: Fid): UpstreamResult<string | null>
  /** Submits an encoded `Message` and returns its hash as the node reports it. */
  submitMessage(bytes: Uint8Array): Promise<Result<{ hash: string }, SubmitError>>
}

/** A SQLite database: D1 in production, `node:sqlite` in memory for `pnpm check`. */
export interface Sql {
  all<T>(sql: string, params?: readonly unknown[]): Promise<T[]>
  /** Runs every statement in one transaction: all of them commit, or none does. */
  batch(statements: readonly SqlStatement[]): Promise<void>
}
export type SqlStatement = { sql: string; params: readonly unknown[] }

export type Cursor = { shard: ShardIndex; lastEventId: EventId; lastBlockTs: Timestamp }

export type ApplyResult = Result<void, { kind: 'cursor_moved' }>

/** Recent casts, recasts, counts, profiles and ingestion state. */
export interface CastIndexWriter {
  cursor(shard: ShardIndex): Promise<Cursor | null>
  /** Starts a shard at a position, as after a first fill or a restart at head. */
  resetCursor(cursor: Cursor): Promise<void>
  /** Applies one event page and moves the cursor from `expected`, exactly once. */
  applyPage(expected: Cursor, next: Cursor, ops: IndexOps): Promise<ApplyResult>
}

export interface ChannelRegistry {
  list(): Promise<Result<ChannelRow[], UpstreamError>>
  /**
   * The channels a FID follows, newest first, where the registry knows them. Channel follows
   * aren't on protocol until V21, so only the Farcaster client API has them; nothing keeps them
   * on our side: the device imports them once and keeps its own list.
   */
  followedBy?(fid: number): Promise<Result<ChannelRow[], UpstreamError>>
}

export interface Clock {
  now(): Timestamp
}

/** A message authentication code over cursors. */
export interface Mac {
  sign(data: string): Promise<string>
  verify(data: string, mac: string): Promise<boolean>
}

export interface Random {
  bytes(n: number): Uint8Array
}

/**
 * A Durable Object's SQLite, synchronous: the user object's own storage. `transaction` runs
 * its function atomically. In tests it is `node:sqlite`.
 */
export interface SyncSql {
  all<T>(sql: string, ...params: unknown[]): T[]
  run(sql: string, ...params: unknown[]): void
  transaction<T>(fn: () => T): T
}
