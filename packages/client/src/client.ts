import { AccountController, type AppKeys, type DeviceVault, type SessionStore } from './account.ts'
import { createApi, type Api, type ApiOptions } from './api.ts'
import { ChannelFollows } from './channel-follows.ts'
import { memoryLocalStore, type LocalStore } from './local.ts'
import { EntityStore } from './store.ts'
import { ViewerStore } from './viewer.ts'

export type WarpClient = {
  /** The deployment's origin, which query keys and on-device records are scoped to. */
  origin: string
  api: Api
  store: EntityStore
  account: AccountController
  viewer: ViewerStore
  channels: ChannelFollows
}

export type ClientOptions = ApiOptions & {
  /** The app key port; `null` where this platform can't hold one yet, which leaves the client read-only. */
  keys?: AppKeys | null
  /** The phone's native vault, which approves sign-ins from its own sheet. */
  vault?: DeviceVault | null
  /** Where the session token survives a relaunch. */
  sessions?: SessionStore | null
  /** Unix seconds. */
  now?: () => number
  /** On-device records (followed channels); in memory when absent. */
  local?: LocalStore | null
}

/**
 * The headless client: the typed API, the entity store,
 * the signed-in account and its viewer overlay.
 */
export const createClient = (options: ClientOptions): WarpClient => {
  // The API sends the account's session token, and the account renews it through the API.
  let account: AccountController | null = null
  const origin = new URL(options.baseUrl).origin
  const api = createApi({
    ...options,
    auth: {
      token: () => account?.token() ?? null,
      renew: () => account?.renewSession() ?? Promise.resolve(null),
      ready: () => account?.ready() ?? Promise.resolve(),
    },
  })
  account = new AccountController({
    api, keys: options.keys ?? null, vault: options.vault ?? null, sessions: options.sessions ?? null,
    // The key signs sessions for the origin this app was built against, never one a server names.
    origin,
    now: options.now ?? (() => Math.floor(Date.now() / 1_000)),
  })
  return { origin, api, store: new EntityStore(), account, viewer: new ViewerStore(), channels: new ChannelFollows(options.local ?? memoryLocalStore(), api) }
}
