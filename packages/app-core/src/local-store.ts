import type { LocalStore } from '@warpstack/client'
import { Directory, File, Paths } from 'expo-file-system'
import { Platform } from 'react-native'

// The device's on-device records (the client's LocalStore port): on the phone, one small JSON
// file per record in the app's own documents folder, which no other app can read and the
// server never sees; on the web, localStorage. Records here are preferences, not secrets:
// the session token stays in the Keychain.

const fileStore = (): LocalStore => {
  const dir = new Directory(Paths.document, 'warpstack')
  // Keys hold origins (`https://…`), so they're encoded into a safe file name.
  const fileOf = (key: string) => new File(dir, `${encodeURIComponent(key)}.json`)
  return {
    get: async key => {
      const f = fileOf(key)
      return f.exists ? f.text() : null
    },
    set: async (key, value) => {
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true })
      const f = fileOf(key)
      if (!f.exists) f.create()
      await f.write(value)
    },
    remove: async key => {
      const f = fileOf(key)
      if (f.exists) f.delete()
    },
  }
}

const webStore = (): LocalStore => ({
  // Private browsing can refuse storage; the app then keeps records for the session only.
  get: async key => {
    try {
      return globalThis.localStorage?.getItem(key) ?? null
    } catch {
      return null
    }
  },
  set: async (key, value) => {
    try {
      globalThis.localStorage?.setItem(key, value)
    } catch {
      // not kept
    }
  },
  remove: async key => {
    try {
      globalThis.localStorage?.removeItem(key)
    } catch {
      // nothing to remove
    }
  },
})

export const deviceLocalStore = (): LocalStore => (Platform.OS === 'web' ? webStore() : fileStore())
