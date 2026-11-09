import type { Api } from './api.ts'
import type { LocalStore } from './local.ts'

// Followed channels, on the device: channel follows stay on the device in v1. Channel
// follows aren't on protocol until V21, so the list starts as a one-time import of what the
// account follows on Farcaster, through the server, which keeps nothing.
// Follows and unfollows after that stay on this device.

/** What the device keeps per channel: enough to list it and open its feed. */
export type FollowedChannel = { key: string; name: string; url: string; image?: string | undefined }
export type ChannelFollowsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; channels: FollowedChannel[]; imported: boolean; error?: string }

/** `unfollowed`: channels unfollowed on this device, which a reimport from Farcaster mustn't bring back. */
type Record = { v: 1; imported: boolean; channels: FollowedChannel[]; unfollowed: string[] }

const MAX = 1_000
const keyOf = (origin: string, fid: number) => `warpstack.channels.v1:${origin}:${fid}`

const parse = (raw: string | null): Record | null => {
  if (!raw) return null
  try {
    const r = JSON.parse(raw) as Partial<Record>
    if (r.v !== 1 || !Array.isArray(r.channels)) return null
    const channels = r.channels.filter((c): c is FollowedChannel =>
      !!c && typeof c.key === 'string' && typeof c.name === 'string' && typeof c.url === 'string'
      && (c.image === undefined || typeof c.image === 'string')).slice(0, MAX)
    const unfollowed = Array.isArray(r.unfollowed) ? r.unfollowed.filter((k): k is string => typeof k === 'string').slice(0, MAX) : []
    return { v: 1, imported: r.imported === true, channels, unfollowed }
  } catch {
    return null
  }
}

const slim = (c: FollowedChannel): FollowedChannel => ({ key: c.key, name: c.name, url: c.url, ...(c.image ? { image: c.image } : {}) })

export class ChannelFollows {
  private state: ChannelFollowsState = { kind: 'idle' }
  private scope: string | null = null
  private unfollowed: string[] = []
  private readonly listeners = new Set<() => void>()

  constructor(private readonly local: LocalStore, private readonly api: Api) {}

  subscribe(l: () => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  snapshot(): ChannelFollowsState {
    return this.state
  }

  private set(next: ChannelFollowsState) {
    this.state = next
    for (const l of this.listeners) l()
  }

  /**
   * Loads this account's list from the device, importing it from Farcaster the first time.
   * A failed import leaves the list as it was and is tried again on the next load.
   */
  async load(origin: string, fid: number): Promise<void> {
    const scope = keyOf(origin, fid)
    if (this.scope === scope && this.state.kind !== 'idle') return
    this.scope = scope
    this.set({ kind: 'loading' })
    const stored = parse(await this.local.get(scope))
    if (this.scope !== scope) return
    this.unfollowed = stored?.unfollowed ?? []
    if (stored?.imported) return this.set({ kind: 'ready', channels: stored.channels, imported: true })
    await this.importFrom(scope, stored?.channels ?? [])
  }

  /** Imports again: fresh names and images, and channels followed on Farcaster since, except any unfollowed here. */
  async reimport(): Promise<void> {
    if (!this.scope) return
    await this.importFrom(this.scope, this.state.kind === 'ready' ? this.state.channels : [])
  }

  private async importFrom(scope: string, have: FollowedChannel[]) {
    try {
      const r = await this.api.viewer.channels({})
      if (this.scope !== scope) return
      // Channels already here keep their place and get fresh names and images; new ones follow.
      const fresh = new Map(r.channels.map(c => [c.key as string, slim(c)]))
      const skip = new Set([...have.map(c => c.key), ...this.unfollowed])
      const channels = [...have.map(c => fresh.get(c.key) ?? c), ...r.channels.filter(c => !skip.has(c.key)).map(slim)].slice(0, MAX)
      await this.save(scope, { v: 1, imported: true, channels, unfollowed: this.unfollowed })
      this.set({ kind: 'ready', channels, imported: true })
    } catch {
      if (this.scope !== scope) return
      this.set({ kind: 'ready', channels: have, imported: false, error: "Couldn't import your channels from Farcaster. Pull to refresh to try again." })
    }
  }

  isFollowing(key: string): boolean {
    return this.state.kind === 'ready' && this.state.channels.some(c => c.key === key)
  }

  async follow(channel: FollowedChannel): Promise<void> {
    if (this.state.kind !== 'ready' || !this.scope || this.isFollowing(channel.key)) return
    const channels = [slim(channel), ...this.state.channels].slice(0, MAX)
    this.unfollowed = this.unfollowed.filter(k => k !== channel.key)
    this.set({ ...this.state, channels })
    await this.save(this.scope, { v: 1, imported: this.state.imported, channels, unfollowed: this.unfollowed })
  }

  async unfollow(key: string): Promise<void> {
    if (this.state.kind !== 'ready' || !this.scope) return
    const channels = this.state.channels.filter(c => c.key !== key)
    this.unfollowed = [key, ...this.unfollowed.filter(k => k !== key)].slice(0, MAX)
    this.set({ ...this.state, channels })
    await this.save(this.scope, { v: 1, imported: this.state.imported, channels, unfollowed: this.unfollowed })
  }

  /** Forgets the account in memory (sign-out); the record stays on the device, like mutes. */
  reset(): void {
    this.scope = null
    this.unfollowed = []
    this.set({ kind: 'idle' })
  }

  private async save(scope: string, r: Record) {
    await this.local.set(scope, JSON.stringify(r))
  }
}
