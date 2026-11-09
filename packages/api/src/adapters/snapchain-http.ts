import { err, ok, type CastHash, type EventId, type Fid, type ShardIndex } from '@warpstack/protocol'
import type { z } from 'zod'
import { FARCASTER_EPOCH, type Result } from '@warpstack/protocol'
import {
  EventsResponse, HubEvent, InfoResponse, MESSAGE_TYPE_NUMBERS, MessagesResponse, OnChainEventsResponse, SignersResponse,
  StorageLimitsResponse, SubmitResponse, UserNameProofResponse, Message, type CastId,
} from '../core/snapchain-types.ts'
import type {
  EventPage, MessagePage, PageRequest, Signers, Snapchain, StorageLimits, SubmitError, UpstreamError, UpstreamResult,
} from '../ports.ts'

export type SnapchainNode = { url: string; accessToken?: string | undefined }

// Snapchain's HTTP API on one node. The node is a fixed, operator-configured host, not an
// attacker-chosen URL, so this adapter doesn't go through the untrusted-content transport.
// Facts from the public node (Oct 2026): https only; `/v1/events` pages by `from_event_id`
// and has no page token; list endpoints that span shards return up to `pageSize` per shard.

const TIMEOUT_MS = 8_000

export class HttpSnapchain implements Snapchain {
  constructor(private readonly node: SnapchainNode, private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', ...extra }
    if (this.node.accessToken) {
      // The secret may itself contain ':'; only the first one separates the two.
      const at = this.node.accessToken.indexOf(':')
      if (at > 0) {
        headers['cf-access-client-id'] = this.node.accessToken.slice(0, at)
        headers['cf-access-client-secret'] = this.node.accessToken.slice(at + 1)
      }
    }
    return headers
  }

  private async get<T>(path: string, params: Record<string, string | number | boolean | undefined>, schema: z.ZodType<T>):
    UpstreamResult<T | null> {
    const url = new URL(path, this.node.url)
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v))
    const headers = this.headers()
    let res: Response
    try {
      res = await this.fetcher(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (e) {
      return err(unavailable(`${path}: ${String(e)}`))
    }
    if (res.status === 404) return ok(null)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // Snapchain answers a missing message with 400 and a "not found" error code.
      if (res.status === 400 && /not_found|NotFound|not found/i.test(body)) return ok(null)
      return err(res.status >= 500 || res.status === 429 ? unavailable(`${path}: ${res.status}`) : bad(`${path}: ${res.status} ${body.slice(0, 200)}`))
    }
    const parsed = schema.safeParse(await res.json().catch(() => undefined))
    return parsed.success ? ok(parsed.data) : err(bad(`${path}: ${parsed.error.message.slice(0, 300)}`))
  }

  private async page(path: string, params: Record<string, string | number | undefined>, page: PageRequest): UpstreamResult<MessagePage> {
    const r = await this.get(path, { ...params, pageSize: page.size, reverse: page.reverse, pageToken: page.token }, MessagesResponse)
    if (!r.ok) return r
    return ok({ messages: r.value?.messages ?? [], next: liveToken(r.value?.nextPageToken) })
  }

  async events(shard: ShardIndex, from: EventId, pageSize: number): UpstreamResult<EventPage> {
    const r = await this.get('/v1/events', { shard_index: shard, from_event_id: from, page_size: pageSize }, EventsResponse)
    if (!r.ok) return r
    return ok(parseEvents(r.value?.events ?? []))
  }

  async heads(): UpstreamResult<Map<ShardIndex, number>> {
    const r = await this.get('/v1/info', {}, InfoResponse)
    if (!r.ok) return r
    return ok(new Map((r.value?.shardInfos ?? []).filter(s => s.shardId === 1 || s.shardId === 2)
      .map(s => [s.shardId as ShardIndex, s.maxHeight])))
  }

  async castById(fid: Fid, hash: CastHash): UpstreamResult<Message | null> {
    return this.get('/v1/castById', { fid, hash }, Message)
  }

  castsByFid(fid: Fid, page: PageRequest) { return this.page('/v1/castsByFid', { fid }, page) }

  castsByParent(parent: CastId, page: PageRequest) {
    return this.page('/v1/castsByParent', { fid: parent.fid, hash: parent.hash }, page)
  }

  reactionsByCast(cast: CastId, kind: 'like' | 'recast', page: PageRequest) {
    return this.page('/v1/reactionsByCast', {
      target_fid: cast.fid, target_hash: cast.hash, reaction_type: kind === 'like' ? 'Like' : 'Recast',
    }, page)
  }

  linksByFid(fid: Fid, page: PageRequest, type: 'follow' | 'block' = 'follow') { return this.page('/v1/linksByFid', { fid, link_type: type }, page) }

  linksByTarget(fid: Fid, page: PageRequest) {
    return this.page('/v1/linksByTargetFid', { target_fid: fid, link_type: 'follow' }, page)
  }

  async userData(fid: Fid): UpstreamResult<Message[]> {
    const r = await this.get('/v1/userDataByFid', { fid, pageSize: 100 }, MessagesResponse)
    return r.ok ? ok(r.value?.messages ?? []) : r
  }

  async verifications(fid: Fid): UpstreamResult<Message[]> {
    const r = await this.get('/v1/verificationsByFid', { fid, pageSize: 25 }, MessagesResponse)
    return r.ok ? ok(r.value?.messages ?? []) : r
  }

  async storageLimits(fid: Fid): UpstreamResult<StorageLimits> {
    const r = await this.get('/v1/storageLimitsByFid', { fid }, StorageLimitsResponse)
    if (!r.ok) return r
    const stores = (r.value?.limits ?? []).map(l => ({ type: l.storeType ?? l.name ?? '', used: l.used, limit: l.limit }))
    const now = Date.now() / 1000
    const subs = [
      ...(r.value?.tier_subscriptions ?? []).map(s => ({ tier: s.tier_type, expires: s.expires_at })),
      ...(r.value?.tierSubscriptions ?? []).map(s => ({ tier: s.tierType, expires: s.expiresAt })),
    ]
    return ok({ pro: subs.some(s => /pro/i.test(s.tier) && s.expires > now), stores })
  }

  async fidByUsername(name: string): UpstreamResult<Fid | null> {
    const r = await this.get('/v1/userNameProofByName', { name }, UserNameProofResponse)
    return r.ok ? ok((r.value?.fid ?? null) as Fid | null) : r
  }

  castsByMention(fid: Fid, page: PageRequest) { return this.page('/v1/castsByMention', { fid }, page) }

  reactionsByFid(fid: Fid, kind: 'like' | 'recast', page: PageRequest) {
    return this.page('/v1/reactionsByFid', { fid, reaction_type: kind === 'like' ? 'Like' : 'Recast' }, page)
  }

  async signers(fid: Fid, requesterFids: readonly Fid[]): UpstreamResult<Signers> {
    // The public node parses `requesterFids[]=…` and refuses a bare or repeated `requesterFids`
    // (checked Oct 25). One requester is all M1.5 asks for.
    const r = await this.get('/v1/signersByFid', { fid, 'requesterFids[]': requesterFids[0] }, SignersResponse)
    if (!r.ok) return r
    const v = r.value ?? { signers: [], currentUserNonce: 0, requesterFidNonces: {} }
    return ok({
      userNonce: v.currentUserNonce,
      requesterNonces: new Map(Object.entries(v.requesterFidNonces).map(([k, n]) => [Number(k), n])),
      keys: v.signers.filter(s => s.keyType === 1 && s.key.length === 66).map(s => ({
        key: s.key,
        source: /ONCHAIN/.test(s.source) ? 'onchain' as const : 'gasless' as const,
        scopes: s.scopes.map(n => MESSAGE_TYPE_NUMBERS[n]).filter((n): n is number => n !== undefined),
        requestFid: s.requestFid ?? undefined,
        addedAt: unixSeconds(s.addedAt),
        lastUsedAt: unixSeconds(s.lastUsedAt),
        expiresAt: unixSeconds(s.expiresAt),
      })),
    })
  }

  async custodyOf(fid: Fid): UpstreamResult<string | null> {
    const r = await this.get('/v1/onChainEventsByFid', { fid, event_type: 'EVENT_TYPE_ID_REGISTER' }, OnChainEventsResponse)
    if (!r.ok) return r
    // The custody address is the `to` of the latest register or transfer.
    const owners = (r.value?.events ?? [])
      .filter(e => e.idRegisterEventBody && /^(Register|Transfer)$/i.test(e.idRegisterEventBody.eventType) && e.idRegisterEventBody.to.length === 42)
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    return ok(owners.at(-1)?.idRegisterEventBody?.to ?? null)
  }

  async submitMessage(bytes: Uint8Array): Promise<Result<{ hash: string }, SubmitError>> {
    let res: Response
    try {
      res = await this.fetcher(new URL('/v1/submitMessage', this.node.url), {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/octet-stream' }),
        body: Uint8Array.from(bytes),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      return err(unavailable(`submitMessage: ${String(e)}`))
    }
    const text = await res.text().catch(() => '')
    if (res.status >= 500 || res.status === 429) return err(unavailable(`submitMessage: ${res.status}`))
    if (!res.ok) return err({ kind: 'rejected', detail: rejectionOf(text) })
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      return err(bad('submitMessage: not JSON'))
    }
    const parsed = SubmitResponse.safeParse(json)
    return parsed.success ? ok({ hash: parsed.data.hash }) : err(bad('submitMessage: no hash'))
  }
}

/**
 * Gasless signer times may come in Farcaster time; anything before 2021 in Unix seconds is
 * taken as Farcaster time and converted.
 */
const unixSeconds = (t: number | null | undefined): number | undefined =>
  t === null || t === undefined || t <= 0 ? undefined : t < FARCASTER_EPOCH ? t + FARCASTER_EPOCH : t

/**
 * The node's reason, from `{ error, error_detail }`, as plain printable text: it goes back to
 * the client, so it's cut down to the validation code and a short message.
 */
export const rejectionOf = (body: string): string => {
  let detail = body
  try {
    const j = JSON.parse(body) as { error?: unknown; error_detail?: unknown; errCode?: unknown; details?: unknown }
    detail = String(j.error_detail ?? j.details ?? j.errCode ?? j.error ?? body)
  } catch {
    // Not JSON: use the text.
  }
  const code = /(bad_request\.[a-z_]+(?:\/[\w .:/'()=<>-]*)?)/.exec(detail)?.[1]
  return (code ?? detail).replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || 'refused by the node'
}

const unavailable = (detail: string): UpstreamError => ({ kind: 'unavailable', detail })
const bad = (detail: string): UpstreamError => ({ kind: 'bad_response', detail })

/**
 * Lists that span shards return a token per shard, base64 JSON like `[null,null]` once every
 * shard is exhausted. That isn't another page.
 */
export const liveToken = (token: string | null | undefined): string | undefined => {
  if (!token) return undefined
  try {
    const parts = JSON.parse(atob(token)) as unknown
    if (Array.isArray(parts) && parts.every(p => p === null)) return undefined
  } catch {
    // An opaque single-shard token.
  }
  return token
}

/**
 * Parses each event on its own. An event that fails is skipped and counted rather than
 * failing the page, which would otherwise stop ingestion at that event ID forever. The last
 * raw ID is kept even when that event is skipped, so the cursor still moves past it.
 */
export const parseEvents = (raw: readonly unknown[]): EventPage => {
  const events: HubEvent[] = []
  let skipped = 0
  let lastId: number | null = null
  for (const e of raw) {
    const id = (e as { id?: unknown })?.id
    if (typeof id === 'number' && Number.isSafeInteger(id)) lastId = id
    const parsed = HubEvent.safeParse(e)
    if (parsed.success) events.push(parsed.data)
    else skipped++
  }
  return { events, skipped, lastId: lastId as EventId | null }
}
