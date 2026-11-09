import { describe, expect, it } from 'vitest'
import { EntityStore, STORE_LIMITS } from './store.ts'

const cast = (hash: string, likes: number, display = 'A') => ({
  hash, fid: 1, ts: 1, type: 'cast', text: 't', embeds: [], mentions: [],
  counts: { likes, recasts: 0, replies: 0, exact: true }, author: { fid: 1, displayName: display, pro: false },
}) as never

describe('the entity store', () => {
  it('merges by rev: an older snapshot never rolls counts or authors back', () => {
    const s = new EntityStore()
    s.mergeCasts([cast('0x1', 5, 'New')], 10)
    s.mergeCasts([cast('0x1', 2, 'Old')], 9)
    expect(s.cast('0x1')?.counts.likes).toBe(5)
    expect(s.cast('0x1')?.author.displayName).toBe('New')
    s.mergeCasts([cast('0x1', 7)], 10)
    expect(s.cast('0x1')?.counts.likes).toBe(7)
  })

  it('reads authors through the user record, so a rename shows on every cast', () => {
    const s = new EntityStore()
    s.mergeCasts([cast('0x1', 0, 'Alice'), cast('0x2', 0, 'Alice')], 1)
    s.mergeUsers([{ fid: 1, displayName: 'Alicia', pro: false } as never], 2)
    expect(s.cast('0x1')?.author.displayName).toBe('Alicia')
    expect(s.cast('0x2')?.author.displayName).toBe('Alicia')
  })

  it('evicts the least recently written past its bound', () => {
    const s = new EntityStore()
    for (let i = 0; i <= STORE_LIMITS.casts; i++) s.mergeCasts([cast(`0x${i}`, 0)], 1)
    expect(s.sizes.casts).toBe(STORE_LIMITS.casts)
    expect(s.cast('0x0')).toBeUndefined()
  })

  it('notifies subscribers on a merge that changes something, and not on one that doesn\'t', () => {
    const s = new EntityStore()
    let n = 0
    s.subscribe(() => n++)
    s.mergeCasts([cast('0x1', 0)], 1)
    expect(n).toBe(1)
    s.mergeCasts([cast('0x1', 0)], 2)
    expect(n).toBe(1)
    s.mergeCasts([cast('0x1', 1)], 3)
    expect(n).toBe(2)
  })

  it('returns the same object for a cast until it, its author or its pending counts change', () => {
    let now = 0
    const s = new EntityStore(() => now)
    s.mergeCasts([cast('0x1', 0), cast('0x2', 0)], 1)
    const a = s.cast('0x1')
    expect(s.cast('0x1')).toBe(a)
    s.mergeCasts([cast('0x1', 0)], 2)
    expect(s.cast('0x1')).toBe(a)
    s.mergeCasts([cast('0x2', 3)], 3)
    expect(s.cast('0x1')).toBe(a)
    const id = s.pendCounts('0x1', { likes: 1 })
    const pended = s.cast('0x1')
    expect(pended).not.toBe(a)
    expect(pended!.counts.likes).toBe(1)
    s.mergedCounts('0x1', id)
    expect(s.cast('0x1')).toBe(pended)
    // The change runs out: the cast is recomposed without it.
    now += 3 * 60_000
    expect(s.cast('0x1')!.counts.likes).toBe(0)
  })

  it('calls a selector\'s listener only when what it selects changes', () => {
    const s = new EntityStore()
    s.mergeCasts([cast('0x1', 0), cast('0x2', 0)], 1)
    const seen: number[] = []
    const stop = s.subscribe(st => st.cast('0x1')!.counts.likes, v => seen.push(v))
    s.mergeCasts([cast('0x2', 5)], 2)
    s.mergeCasts([cast('0x1', 4)], 3)
    s.mergeCasts([cast('0x1', 4)], 4)
    stop()
    s.mergeCasts([cast('0x1', 9)], 5)
    expect(seen).toEqual([4])
  })

  it('shows a local count change over snapshots until one includes it, and drops it if the write fails', () => {
    let now = 0
    const s = new EntityStore(() => now)
    const base = cast('0xa', 5)
    s.mergeCasts([base], 10)
    const like = s.pendCounts('0xa', { likes: 1 })
    expect(s.cast('0xa')!.counts.likes).toBe(6)
    // A response read at the same revision, before the like merged, doesn't undo it.
    s.mergeCasts([cast('0xa', 5)], 10)
    expect(s.cast('0xa')!.counts.likes).toBe(6)
    // Merged: the next newer snapshot has it, and it isn't counted twice.
    s.mergedCounts('0xa', like)
    s.mergeCasts([cast('0xa', 6)], 11)
    expect(s.cast('0xa')!.counts.likes).toBe(6)
    // A failed write comes off.
    const recast = s.pendCounts('0xa', { recasts: 1 })
    expect(s.cast('0xa')!.counts.recasts).toBe(1)
    s.dropCounts('0xa', recast)
    expect(s.cast('0xa')!.counts.recasts).toBe(0)
    // One that never confirms stops counting after a while.
    s.pendCounts('0xa', { likes: -1 })
    now += 3 * 60_000
    expect(s.cast('0xa')!.counts.likes).toBe(6)
  })
})
