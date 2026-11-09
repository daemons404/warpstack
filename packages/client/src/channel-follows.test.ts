import { describe, expect, it } from 'vitest'
import type { Api } from './api.ts'
import { ChannelFollows } from './channel-follows.ts'
import { memoryLocalStore } from './local.ts'

// Followed channels live on the device: imported from Farcaster once, then changed only here.

const ch = (key: string) => ({ key, name: key.toUpperCase(), url: `https://farcaster.xyz/~/channel/${key}`, moderators: [] })
const apiWith = (lists: ({ key: string }[] | 'fail')[]) => {
  let calls = 0
  const api = {
    viewer: {
      channels: async () => {
        const next = lists[Math.min(calls++, lists.length - 1)]!
        if (next === 'fail') throw new Error('upstream')
        return { channels: next.map(c => ch(c.key)) }
      },
    },
  } as unknown as Api
  return { api, calls: () => calls }
}

describe('followed channels on the device', () => {
  it('imports once, then reads only from the device', async () => {
    const local = memoryLocalStore()
    const { api, calls } = apiWith([[{ key: 'base' }, { key: 'golf' }]])
    const a = new ChannelFollows(local, api)
    await a.load('https://w.test', 7)
    expect(a.snapshot()).toMatchObject({ kind: 'ready', imported: true, channels: [{ key: 'base' }, { key: 'golf' }] })
    // A later launch reads the device and asks Farcaster nothing.
    const b = new ChannelFollows(local, api)
    await b.load('https://w.test', 7)
    expect(b.snapshot()).toMatchObject({ kind: 'ready', channels: [{ key: 'base' }, { key: 'golf' }] })
    expect(calls()).toBe(1)
  })

  it('keeps follows and unfollows on the device, and stores only key, name and url', async () => {
    const local = memoryLocalStore()
    const a = new ChannelFollows(local, apiWith([[{ key: 'base' }]]).api)
    await a.load('https://w.test', 7)
    await a.follow({ key: 'memes', name: 'Memes', url: 'https://farcaster.xyz/~/channel/memes' })
    await a.unfollow('base')
    expect(a.isFollowing('memes')).toBe(true)
    expect(a.isFollowing('base')).toBe(false)
    const stored = JSON.parse((await local.get('warpstack.channels.v1:https://w.test:7'))!)
    expect(stored).toEqual({ v: 1, imported: true, channels: [{ key: 'memes', name: 'Memes', url: 'https://farcaster.xyz/~/channel/memes' }], unfollowed: ['base'] })
  })

  it('tries the import again next time if it failed, and a reimport adds new ones but never undoes an unfollow', async () => {
    const local = memoryLocalStore()
    const { api } = apiWith(['fail', [{ key: 'base' }], [{ key: 'base' }, { key: 'golf' }]])
    const a = new ChannelFollows(local, api)
    await a.load('https://w.test', 7)
    expect(a.snapshot()).toMatchObject({ kind: 'ready', imported: false, channels: [], error: expect.any(String) })
    const b = new ChannelFollows(local, api)
    await b.load('https://w.test', 7)
    expect(b.snapshot()).toMatchObject({ kind: 'ready', imported: true, channels: [{ key: 'base' }] })
    await b.unfollow('base')
    await b.reimport()
    // Farcaster still lists /base, but it was unfollowed here; /golf is new there.
    expect(b.snapshot()).toMatchObject({ channels: [{ key: 'golf' }] })
    // Following it again here clears the unfollow.
    await b.follow({ key: 'base', name: 'Base', url: 'https://farcaster.xyz/~/channel/base' })
    await b.reimport()
    expect(b.snapshot()).toMatchObject({ channels: [{ key: 'base' }, { key: 'golf' }] })
  })

  it('keeps each account separate', async () => {
    const local = memoryLocalStore()
    const a = new ChannelFollows(local, apiWith([[{ key: 'base' }]]).api)
    await a.load('https://w.test', 7)
    const b = new ChannelFollows(local, apiWith([[{ key: 'golf' }]]).api)
    await b.load('https://w.test', 8)
    expect(b.snapshot()).toMatchObject({ channels: [{ key: 'golf' }] })
  })

  it('refreshes names and images of channels it already has on a reimport', async () => {
    const local = memoryLocalStore()
    const served: { image?: string } = {}
    const api = { viewer: { channels: async () => ({ channels: [{ ...ch('base'), ...served }] }) } } as unknown as Api
    const a = new ChannelFollows(local, api)
    await a.load('https://w.test', 7)
    expect(a.snapshot()).toMatchObject({ channels: [{ key: 'base' }] })
    served.image = `a/${'0'.repeat(64)}/144`
    await a.reimport()
    expect(a.snapshot()).toMatchObject({ channels: [{ key: 'base', image: served.image }] })
  })
})
