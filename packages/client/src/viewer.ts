// The signed-in account's own state over shared data: which
// casts it liked or recast and whom it follows. Server snapshots replace the sets; a change
// made here holds over snapshots for a while, because the node and the index take a few
// seconds to reflect a write, and a snapshot read in that gap would otherwise undo it on screen.

const HOLD_MS = 2 * 60_000

type Kind = 'like' | 'recast' | 'follow'
type Override = { on: boolean; until: number; id: number }

export class ViewerStore {
  private sets: Record<Kind, Set<string>> = { like: new Set(), recast: new Set(), follow: new Set() }
  private readonly overrides = new Map<string, Override>()
  private readonly listeners = new Set<() => void>()
  private version = 0
  private nextId = 0
  loaded = false

  constructor(private readonly nowMs: () => number = () => Date.now()) {}

  /** Replaces the sets with a snapshot from the server. */
  apply(s: { likes: readonly string[]; recasts: readonly string[]; following: readonly number[] }): void {
    this.sets = { like: new Set(s.likes), recast: new Set(s.recasts), follow: new Set(s.following.map(String)) }
    this.loaded = true
    this.bump()
  }

  has(kind: Kind, id: string | number): boolean {
    const key = `${kind}:${id}`
    const o = this.overrides.get(key)
    if (o && o.until > this.nowMs()) return o.on
    if (o) this.overrides.delete(key)
    return this.sets[kind].has(String(id))
  }

  /** A local change, shown until a later snapshot can be trusted to include it. Returns a token for `forget`. */
  set(kind: Kind, id: string | number, on: boolean): number {
    const token = ++this.nextId
    this.overrides.set(`${kind}:${id}`, { on, until: this.nowMs() + HOLD_MS, id: token })
    this.bump()
    return token
  }

  /** Undoes a local change that failed, unless a newer change has replaced it. */
  forget(kind: Kind, id: string | number, token?: number): void {
    const key = `${kind}:${id}`
    if (token !== undefined && this.overrides.get(key)?.id !== token) return
    this.overrides.delete(key)
    this.bump()
  }

  clear(): void {
    this.sets = { like: new Set(), recast: new Set(), follow: new Set() }
    this.overrides.clear()
    this.loaded = false
    this.bump()
  }

  subscribe(l: () => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  snapshot(): number { return this.version }

  private bump() {
    this.version++
    for (const l of this.listeners) l()
  }
}
