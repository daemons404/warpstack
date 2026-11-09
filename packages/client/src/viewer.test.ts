import { describe, expect, it } from 'vitest'
import { ViewerStore } from './viewer.ts'

describe('the viewer overlay', () => {
  it('holds a local change over snapshots, and a failure undoes only its own change', () => {
    let now = 0
    const v = new ViewerStore(() => now)
    v.apply({ likes: [], recasts: [], following: [] })
    const first = v.set('like', '0xa', true)
    // A snapshot from before the write doesn't undo it.
    v.apply({ likes: [], recasts: [], following: [] })
    expect(v.has('like', '0xa')).toBe(true)
    // A second tap replaces the first; the first one's failure leaves it alone.
    const second = v.set('like', '0xa', false)
    v.forget('like', '0xa', first)
    expect(v.has('like', '0xa')).toBe(false)
    v.forget('like', '0xa', second)
    v.apply({ likes: ['0xa'], recasts: [], following: [] })
    expect(v.has('like', '0xa')).toBe(true)
    // After the hold, snapshots decide.
    v.set('like', '0xa', false)
    now += 3 * 60_000
    expect(v.has('like', '0xa')).toBe(true)
  })
})
