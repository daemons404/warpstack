// On-device state (the `KeyValue` port): small records the app keeps on the
// device and the server never sees, such as followed channels. The app shell provides the
// adapter: files on the phone, localStorage on the web. Without one, records live in memory.

export type LocalStore = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export const memoryLocalStore = (): LocalStore => {
  const m = new Map<string, string>()
  return {
    get: async k => m.get(k) ?? null,
    set: async (k, v) => { m.set(k, v) },
    remove: async k => { m.delete(k) },
  }
}
