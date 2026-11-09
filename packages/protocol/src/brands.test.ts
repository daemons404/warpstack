import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { blockHeightOf, eventIdOf, parseCastHash, parseChannelKey, parseFid, parseFname, parseShardIndex } from './index.ts'

describe('branded types', () => {
  it('accepts positive safe integers as FIDs and nothing else', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), n => parseFid(n).ok))
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '3', null]) expect(parseFid(bad).ok).toBe(false)
  })

  it('normalizes cast hashes to lowercase and refuses other lengths', () => {
    const r = parseCastHash('0x08DFF1C49E3FB82E7937AE7C8C708A8AB6DA07A2')
    expect(r.ok && r.value).toBe('0x08dff1c49e3fb82e7937ae7c8c708a8ab6da07a2')
    expect(parseCastHash('0x08df').ok).toBe(false)
    expect(parseCastHash('08dff1c49e3fb82e7937ae7c8c708a8ab6da07a2').ok).toBe(false)
  })

  it('parses fnames, ENS names and channel keys', () => {
    expect(parseFname('dwr').ok).toBe(true)
    expect(parseFname('dwr.eth').ok).toBe(true)
    expect(parseFname('-dwr').ok).toBe(false)
    expect(parseChannelKey('base').ok).toBe(true)
    expect(parseChannelKey('Base').ok).toBe(false)
  })

  it('only data shards 1 and 2 are shard indexes', () => {
    expect(parseShardIndex(0).ok).toBe(false)
    expect(parseShardIndex(1).ok).toBe(true)
    expect(parseShardIndex(3).ok).toBe(false)
  })

  it('round-trips event IDs through block height', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 2 ** 38 }), fc.integer({ min: 0, max: 2 ** 14 - 1 }), (h, s) =>
      blockHeightOf(eventIdOf(h, s)) === h))
    expect(eventIdOf(49540010)).toBe(49540010 * 16384)
  })
})
