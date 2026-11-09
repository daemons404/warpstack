import { err, ok, type CastHash, type EventId, type Fid, type ShardIndex } from '@warpstack/protocol'
import { MT, type CastId, type HubEvent, type Message } from '../core/snapchain-types.ts'
import type { MessagePage, PageRequest, Signers, Snapchain } from '../ports.ts'

/**
 * An in-memory Snapchain for tests and local work without a node. Messages are held as the
 * HTTP API returns them; list reads page by offset tokens, newest first when reversed.
 */
export class FakeSnapchain implements Snapchain {
  readonly messages: Message[] = []
  readonly eventsByShard = new Map<ShardIndex, HubEvent[]>()
  readonly signersByFid = new Map<number, Signers>()
  readonly custody = new Map<number, string>()
  /** Every submitted message, in order; `reject` makes the next submissions fail with that reason. */
  readonly submitted: Uint8Array[] = []
  reject: string | null = null
  /** When true, signer and custody reads fail as if no node answered. */
  down = false
  calls = 0

  add(...ms: Message[]) { this.messages.push(...ms) }

  private list(filter: (m: Message) => boolean, page: PageRequest): MessagePage {
    this.calls++
    const all = this.messages.filter(filter).sort((a, b) => a.data.timestamp - b.data.timestamp || (a.hash < b.hash ? -1 : 1))
    if (page.reverse) all.reverse()
    const from = page.token ? Number(page.token) : 0
    const slice = all.slice(from, from + page.size)
    return { messages: slice, next: from + page.size < all.length ? String(from + page.size) : undefined }
  }

  async events(shard: ShardIndex, from: EventId, pageSize: number) {
    this.calls++
    const events = (this.eventsByShard.get(shard) ?? []).filter(e => e.id >= from).slice(0, pageSize)
    return ok({ events, skipped: 0, lastId: (events.at(-1)?.id ?? null) as EventId | null })
  }

  async heads() {
    return ok(new Map<ShardIndex, number>())
  }

  async castById(fid: Fid, hash: CastHash) {
    this.calls++
    return ok(this.messages.find(m => m.hash === hash && m.data.fid === fid && m.data.type === MT.castAdd) ?? null)
  }

  async castsByFid(fid: Fid, page: PageRequest) {
    return ok(this.list(m => m.data.type === MT.castAdd && m.data.fid === fid, page))
  }

  async castsByParent(parent: CastId, page: PageRequest) {
    return ok(this.list(m => m.data.castAddBody?.parentCastId?.hash === parent.hash, page))
  }

  async reactionsByCast(cast: CastId, kind: 'like' | 'recast', page: PageRequest) {
    const type = kind === 'like' ? 'REACTION_TYPE_LIKE' : 'REACTION_TYPE_RECAST'
    return ok(this.list(m => m.data.reactionBody?.targetCastId?.hash === cast.hash && m.data.reactionBody.type === type, page))
  }

  async linksByFid(fid: Fid, page: PageRequest, type: 'follow' | 'block' = 'follow') {
    return ok(this.list(m => m.data.type === MT.linkAdd && m.data.fid === fid && (m.data.linkBody?.type ?? 'follow') === type, page))
  }

  async linksByTarget(fid: Fid, page: PageRequest) {
    return ok(this.list(m => m.data.type === MT.linkAdd && m.data.linkBody?.targetFid === fid, page))
  }

  async userData(fid: Fid) {
    this.calls++
    return ok(this.messages.filter(m => m.data.type === MT.userDataAdd && m.data.fid === fid))
  }

  async verifications() { return ok([]) }
  async storageLimits() { return ok({ pro: false, stores: [{ type: 'STORE_TYPE_CASTS', used: 3, limit: 100 }] }) }

  async fidByUsername(name: string) {
    const m = this.messages.find(x => x.data.userDataBody?.type === 'USER_DATA_TYPE_USERNAME' && x.data.userDataBody.value === name)
    return ok((m?.data.fid ?? null) as Fid | null)
  }

  async castsByMention(fid: Fid, page: PageRequest) {
    return ok(this.list(m => m.data.type === MT.castAdd && (m.data.castAddBody?.mentions ?? []).includes(fid), page))
  }

  async reactionsByFid(fid: Fid, kind: 'like' | 'recast', page: PageRequest) {
    const type = kind === 'like' ? 'REACTION_TYPE_LIKE' : 'REACTION_TYPE_RECAST'
    return ok(this.list(m => m.data.type === MT.reactionAdd && m.data.fid === fid && m.data.reactionBody?.type === type, page))
  }

  async signers(fid: Fid) {
    if (this.down) return err({ kind: 'unavailable' as const, detail: 'down' })
    return ok(this.signersByFid.get(fid) ?? { keys: [], userNonce: 0, requesterNonces: new Map() })
  }

  async custodyOf(fid: Fid) {
    if (this.down) return err({ kind: 'unavailable' as const, detail: 'down' })
    return ok(this.custody.get(fid) ?? null)
  }

  async submitMessage(bytes: Uint8Array) {
    if (this.reject) return err({ kind: 'rejected' as const, detail: this.reject })
    this.submitted.push(bytes)
    return ok({ hash: `0x${'00'.repeat(20)}` })
  }
}
