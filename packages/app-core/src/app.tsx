import { createClient, type AppKeys, type DeviceVault, type SessionStore, type StoredSession } from '@warpstack/client'
import { NativeAppKeyStore, type WarpstackVaultModule } from '@warpstack/wallet/native'
import { requireOptionalNativeModule } from 'expo'
import * as SecureStore from 'expo-secure-store'
import { retryDelay, shouldRetry, WarpProvider } from '@warpstack/client/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { deviceLocalStore } from './local-store.ts'
import { parseAppConfig, type AppConfig } from './config.ts'

/**
 * The app key store and vault, from the phone's native module: the key lives in the Keychain
 * and the vault approves sign-ins in its own sheet. Browsers, and phone builds without the
 * module, are read-only until a browser can be linked from the phone.
 */
const appKeys = (): { keys: AppKeys | null; vault: DeviceVault | null; sessions: SessionStore | null } => {
  const native = requireOptionalNativeModule<WarpstackVaultModule>('WarpstackVault')
  if (!native) return { keys: null, vault: null, sessions: null }
  const store = new NativeAppKeyStore(native)
  return { keys: store, vault: store, sessions: keychainSessions }
}

const SESSION_ITEM = 'warpstack.session.v1'

const isStoredSession = (v: unknown): v is StoredSession => {
  const s = v as Partial<StoredSession> | null
  return !!s && typeof s.origin === 'string' && typeof s.fid === 'number' && typeof s.key === 'string'
    && typeof s.token === 'string' && typeof s.expiresAt === 'number'
}

/**
 * The session token in the Keychain, readable only while the phone is unlocked and never
 * synced to another device. Only where the native vault exists: a browser holds no session.
 */
const keychainSessions: SessionStore = {
  load: async () => {
    const raw = await SecureStore.getItemAsync(SESSION_ITEM)
    if (!raw) return null
    try {
      const v: unknown = JSON.parse(raw)
      return isStoredSession(v) ? v : null
    } catch {
      return null
    }
  },
  save: async s => {
    if (!s) return SecureStore.deleteItemAsync(SESSION_ITEM)
    await SecureStore.setItemAsync(SESSION_ITEM, JSON.stringify(s), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY })
  },
}

/**
 * The composition root: it wires config and providers and renders
 * nothing of its own. The same root serves the phone and the web export.
 */
export const AppProviders = ({ config: raw, children }: { config: unknown; children: ReactNode }) => {
  const [state] = useState(() => {
    const config: AppConfig = parseAppConfig(raw)
    const client = createClient({ baseUrl: config.apiUrl, ...appKeys(), local: deviceLocalStore() })
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: shouldRetry, retryDelay, refetchOnWindowFocus: false } },
    })
    return { config, client, queryClient }
  })
  // The key's expiry is read again whenever the app comes back to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => {
      if (s === 'active') void state.client.account.checkKey()
    })
    return () => sub.remove()
  }, [state.client])
  return (
    <QueryClientProvider client={state.queryClient}>
      <WarpProvider client={state.client}>{children}</WarpProvider>
    </QueryClientProvider>
  )
}
