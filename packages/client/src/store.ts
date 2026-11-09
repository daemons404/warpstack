import type { Cast, Channel, UserSummary } from '@warpstack/contract'

// The normalized entity store: casts by hash, users by FID,
// channels by key, so a cast looks the same everywhere it appears. Snapshots merge by `rev`,
// the index revision a response was read at, so a
// response that arrives late, or from a cache, never rolls an entity back.
//
// Reads are stable: `cast(hash)` returns the same object until that cast, its author or its
// pending counts change, and a merge that changes nothing keeps the objects it had. So a
// selector over the store (`subscribe(selector, listener)`) can tell what changed by identity,
// and a screen re-renders only for the entities it shows.

/** Bounds, least recently written evicted first. */
export const STORE_LIMITS = { casts: 5_000, users: 2_000, channels: 1_000 } as const

type Stamped<T> = { value: T; rev: number }
type CountDelta = Partial<Record<'likes' | 'recasts' | 'replies', number>>
/**
 * A local write's change to a cast's counts. `after`: the revision held when it was made; once
 * the write has merged, a snapshot at a newer revision includes it. `until`: when it's dropped
 * regardless, so a write that never confirms can't skew a count for good.
 */
type PendingCounts = { id: number; delta: CountDelta; after: number; merged: boolean; until: number }

/** How long a local count change can wait for a snapshot that includes it. */
const PENDING_MS = 2 * 60_000

/** Two flat records with the same own values. */
const shallowEqual = (a: object, b: object): boolean => {
  if (a === b) return true
  const ka = Object.keys(a), kb = Object.keys(b)
  return ka.length === kb.length && ka.every(k => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** A cast as `cast()` last composed it, and what it was composed from. */
type View = { view: Cast; base: Cast; author: UserSummary; pending: readonly PendingCounts[] | undefined; until: number }

class Bounded<K, V> {
  private readonly map = new Map<K, V>()
  constructor(private readonly max: number) {}
  get(k: K) { return this.map.get(k) }
  set(k: K, v: V) {
    this.map.delete(k)
    this.map.set(k, v)
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as K)
  }
  delete(k: K) { this.map.delete(k) }
  get size() { return this.map.size }
}

export class EntityStore {
  private readonly casts = new Bounded<string, Stamped<Cast>>(STORE_LIMITS.casts)
  private readonly users = new Bounded<number, Stamped<UserSummary>>(STORE_LIMITS.users)
  private readonly channels = new Bounded<string, Channel>(STORE_LIMITS.channels)
  private readonly pending = new Map<string, readonly PendingCounts[]>()
  private readonly views = new Bounded<string, View>(STORE_LIMITS.casts)
  private readonly listeners = new Set<() => void>()
  private version = 0
  private nextId = 0

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  /**
   * Merges casts from a response read at `rev`. Counts and author snapshots from a response
   * with an older revision than the one held are ignored. Text, embeds and timestamps never
   * change after first sight.
   */
  mergeCasts(casts: readonly Cast[], rev: number): void {
    let changed = false
    for (const c of casts) {
      const cur = this.casts.get(c.hash)
      if (!cur) {
        this.casts.set(c.hash, { value: c, rev })
        changed = true
      } else if (rev >= cur.rev) {
        const same = shallowEqual(cur.value.counts, c.counts) && shallowEqual(cur.value.author, c.author)
        this.casts.set(c.hash, { value: same ? cur.value : { ...cur.value, counts: c.counts, author: c.author }, rev })
        changed ||= !same
      }
      changed = this.mergeUser(c.author, rev) || changed
      changed = this.settle(c.hash, rev) || changed
    }
    if (changed) this.bump()
  }

  mergeUsers(users: readonly UserSummary[], rev: number): void {
    let changed = false
    for (const u of users) changed = this.mergeUser(u, rev) || changed
    if (changed) this.bump()
  }

  mergeChannels(channels: readonly Channel[]): void {
    let changed = false
    for (const ch of channels) {
      const cur = this.channels.get(ch.key)
      if (cur && shallowEqual(cur, ch)) continue
      this.channels.set(ch.key, ch)
      changed = true
    }
    if (changed) this.bump()
  }

  /** Whether the record changed. A snapshot equal to the one held keeps the held object. */
  private mergeUser(u: UserSummary, rev: number): boolean {
    const cur = this.users.get(u.fid)
    if (cur && rev < cur.rev) return false
    const same = !!cur && shallowEqual(cur.value, u)
    this.users.set(u.fid, { value: same ? cur!.value : u, rev })
    return !same
  }

  /**
   * A cast with its author read through the user record, so a renamed author updates
   * everywhere, and its counts moved by local writes no snapshot has caught up with yet.
   */
  cast(hash: string): Cast | undefined {
    const c = this.casts.get(hash)?.value
    if (!c) {
      this.views.delete(hash)
      return undefined
    }
    const author = this.users.get(c.fid)?.value ?? c.author
    const list = this.pending.get(hash)
    const now = this.nowMs()
    const held = this.views.get(hash)
    if (held && held.base === c && held.author === author && held.pending === list && now < held.until) return held.view
    const pending = (list ?? []).filter(p => p.until > now)
    const sum = (k: keyof CountDelta) => Math.max(0, c.counts[k] + pending.reduce((n, p) => n + (p.delta[k] ?? 0), 0))
    const counts = pending.length ? { ...c.counts, likes: sum('likes'), recasts: sum('recasts'), replies: sum('replies') } : c.counts
    const view = author === c.author && !pending.length ? c : { ...c, author, counts }
    // Recomposed when the next pending change runs out.
    const until = Math.min(Infinity, ...pending.map(p => p.until))
    this.views.set(hash, { view, base: c, author, pending: list, until })
    return view
  }

  /**
   * A local write's change to a cast's counts, shown over every snapshot until one can include
   * it. Returns its id, for `mergedCounts` once the write has merged or `dropCounts` if it failed.
   */
  pendCounts(hash: string, delta: CountDelta): number {
    const id = ++this.nextId
    // A new list, never one changed in place: its identity says the counts changed.
    this.pending.set(hash, [...this.pending.get(hash) ?? [], { id, delta, after: this.casts.get(hash)?.rev ?? 0, merged: false, until: this.nowMs() + PENDING_MS }])
    this.bump()
    return id
  }

  /** The write merged: the next snapshot newer than when it was made includes it. */
  mergedCounts(hash: string, id: number): void {
    // Set in place: it doesn't change what's shown, so the cast keeps its object and nobody is notified.
    const p = this.pending.get(hash)?.find(x => x.id === id)
    if (p) p.merged = true
  }

  /** The write failed: its change comes off. */
  dropCounts(hash: string, id: number): void {
    const list = this.pending.get(hash)?.filter(x => x.id !== id) ?? []
    if (list.length) this.pending.set(hash, list)
    else this.pending.delete(hash)
    this.bump()
  }

  /** Drops the local changes a snapshot at `rev` includes, and any past their time. Whether any went. */
  private settle(hash: string, rev: number): boolean {
    const list = this.pending.get(hash)
    if (!list) return false
    const now = this.nowMs()
    const left = list.filter(p => !(p.merged && rev > p.after) && p.until > now)
    if (left.length === list.length) return false
    if (left.length) this.pending.set(hash, left)
    else this.pending.delete(hash)
    return true
  }

  user(fid: number): UserSummary | undefined { return this.users.get(fid)?.value }
  channel(key: string): Channel | undefined { return this.channels.get(key) }
  get sizes() { return { casts: this.casts.size, users: this.users.size, channels: this.channels.size } }

  /**
   * Calls `listener` after every change; or, given a selector, only when what it selects
   * changes (compared with `equal`, identity by default). Returns the unsubscribe.
   */
  subscribe(listener: () => void): () => void
  subscribe<T>(selector: (store: EntityStore) => T, listener: (value: T) => void, equal?: (a: T, b: T) => boolean): () => void
  subscribe<T>(a: (() => void) | ((store: EntityStore) => T), b?: (value: T) => void, equal: (x: T, y: T) => boolean = Object.is): () => void {
    let listener = a as () => void
    if (b) {
      const select = a as (store: EntityStore) => T
      let last = select(this)
      listener = () => {
        const next = select(this)
        if (equal(last, next)) return
        last = next
        b(next)
      }
    }
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** A number that changes with every change, for `useSyncExternalStore`. */
  snapshot(): number { return this.version }

  private bump() {
    this.version++
    for (const l of this.listeners) l()
  }
}
