import { err, type CastHash, type EventId, type Fid, type Result, type ShardIndex } from '@warpstack/protocol'
import type { CastId } from '../core/snapchain-types.ts'
import type { PageRequest, Snapchain, SubmitError, UpstreamError, UpstreamResult } from '../ports.ts'
import { HttpSnapchain } from './snapchain-http.ts'

// A pool of Snapchain nodes behind the one `Snapchain` port.
// Every job goes to the first healthy node in the configured order and fails over to the next
// when a node is unavailable. A node that answers, even with a refusal, isn't failed over:
// another node would answer the same. Writes go to two nodes when there are two, because
// submission is idempotent by hash and a node relies on gossip to reach a validator.
//
// Health is a circuit breaker per node, kept for the isolate's life: three failures in a row
// open it for 30 seconds, and the first success closes it. With every node open, the pool
// still tries them all rather than fail without asking. Freshness checks from `/v1/info` and
// draining a node from KV (the rest of Operating nodes) build on this without changing it.
//
// Ingestion fails over too, at the same cursor. That relies on event IDs being identical
// across nodes, which they are by construction (block height and sequence) and S1 checks.

export type PoolNode = { name: string; api: Snapchain }

const FAILURES_TO_OPEN = 3
const OPEN_MS = 30_000

type Breaker = { failures: number; openUntil: number }

/** Breakers by node name, shared by every pool in the isolate: a node that's down for one request is down for the next. */
const breakers = new Map<string, Breaker>()

export class PooledSnapchain implements Snapchain {
  constructor(
    private readonly nodes: readonly PoolNode[],
    private readonly nowMs: () => number = () => Date.now(),
    private readonly health: Map<string, Breaker> = breakers,
  ) {
    if (!nodes.length) throw new Error('A Snapchain pool needs at least one node')
  }

  /** Nodes to try, healthy ones first, each group in configured order. */
  private order(): PoolNode[] {
    const now = this.nowMs()
    const open = (n: PoolNode) => (this.health.get(n.name)?.openUntil ?? 0) > now
    return [...this.nodes.filter(n => !open(n)), ...this.nodes.filter(open)]
  }

  private succeeded(n: PoolNode) {
    this.health.delete(n.name)
  }

  private failed(n: PoolNode) {
    const b = this.health.get(n.name) ?? { failures: 0, openUntil: 0 }
    b.failures++
    if (b.failures >= FAILURES_TO_OPEN) b.openUntil = this.nowMs() + OPEN_MS
    this.health.set(n.name, b)
  }

  /** The first node that answers; the next one only when a node is unavailable. */
  private async first<T, E extends { kind: string }>(job: (api: Snapchain) => Promise<Result<T, E>>): Promise<Result<T, E | UpstreamError>> {
    let last: E | UpstreamError = { kind: 'unavailable', detail: 'no Snapchain node answered' }
    for (const n of this.order()) {
      const r = await job(n.api)
      if (r.ok || r.error.kind !== 'unavailable') {
        this.succeeded(n)
        return r
      }
      this.failed(n)
      last = { ...r.error, detail: `${n.name}: ${(r.error as unknown as UpstreamError).detail}` }
    }
    return err(last)
  }

  events(shard: ShardIndex, from: EventId, pageSize: number) { return this.first(a => a.events(shard, from, pageSize)) }
  heads() { return this.first(a => a.heads()) }
  castById(fid: Fid, hash: CastHash) { return this.first(a => a.castById(fid, hash)) }
  castsByFid(fid: Fid, page: PageRequest) { return this.first(a => a.castsByFid(fid, page)) }
  castsByParent(parent: CastId, page: PageRequest) { return this.first(a => a.castsByParent(parent, page)) }
  reactionsByCast(cast: CastId, kind: 'like' | 'recast', page: PageRequest) { return this.first(a => a.reactionsByCast(cast, kind, page)) }
  linksByFid(fid: Fid, page: PageRequest, type?: 'follow' | 'block') { return this.first(a => a.linksByFid(fid, page, type)) }
  linksByTarget(fid: Fid, page: PageRequest) { return this.first(a => a.linksByTarget(fid, page)) }
  userData(fid: Fid) { return this.first(a => a.userData(fid)) }
  verifications(fid: Fid) { return this.first(a => a.verifications(fid)) }
  storageLimits(fid: Fid) { return this.first(a => a.storageLimits(fid)) }
  fidByUsername(name: string) { return this.first(a => a.fidByUsername(name)) }
  castsByMention(fid: Fid, page: PageRequest) { return this.first(a => a.castsByMention(fid, page)) }
  reactionsByFid(fid: Fid, kind: 'like' | 'recast', page: PageRequest) { return this.first(a => a.reactionsByFid(fid, kind, page)) }
  signers(fid: Fid, requesterFids: readonly Fid[]) { return this.first(a => a.signers(fid, requesterFids)) }
  custodyOf(fid: Fid): UpstreamResult<string | null> { return this.first(a => a.custodyOf(fid)) }

  /**
   * Submits to the first two nodes that answer. Accepted by either is accepted; otherwise a
   * refusal, which says why, beats "unavailable".
   */
  async submitMessage(bytes: Uint8Array): Promise<Result<{ hash: string }, SubmitError>> {
    const results: Result<{ hash: string }, SubmitError>[] = []
    for (const n of this.order()) {
      if (results.filter(r => r.ok || r.error.kind !== 'unavailable').length >= 2) break
      const r = await n.api.submitMessage(bytes)
      if (r.ok || r.error.kind !== 'unavailable') this.succeeded(n)
      else this.failed(n)
      results.push(r)
    }
    return results.find(r => r.ok)
      ?? results.find(r => !r.ok && r.error.kind === 'rejected')
      ?? results.find(r => !r.ok && r.error.kind === 'bad_response')
      ?? results.at(-1)
      ?? err({ kind: 'unavailable', detail: 'no Snapchain node answered' })
  }
}

/**
 * The deployment's Snapchain: its one node, or a pool of them in the order configured. Every
 * node shares the access token, as nodes behind one Cloudflare Access application do.
 */
export const snapchainOf = (s: { nodes: readonly string[]; accessToken?: string | undefined }): Snapchain => {
  const http = s.nodes.map(url => ({ name: new URL(url).host, api: new HttpSnapchain({ url, accessToken: s.accessToken }) }))
  return http.length === 1 ? http[0]!.api : new PooledSnapchain(http)
}
