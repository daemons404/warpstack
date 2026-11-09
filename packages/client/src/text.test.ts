import { describe, expect, it } from 'vitest'
import { castSegments, relativeTime } from './text.ts'

const links = (text: string) => castSegments({ text, mentions: [] }).filter(s => s.kind === 'link').map(s => (s as { url: string }).url)
const channels = (text: string) => castSegments({ text, mentions: [] }).filter(s => s.kind === 'channel').map(s => (s as { key: string }).key)

describe('cast text', () => {
  it('places mentions at UTF-8 byte offsets, after multi-byte characters', () => {
    // "gm 🌞 " is 3 + 4 + 1 = 8 bytes but 6 UTF-16 units.
    const segs = castSegments({ text: 'gm 🌞  and friends', mentions: [{ fid: 3, pos: 8, username: 'dwr' } as never] })
    expect(segs).toEqual([
      { kind: 'text', text: 'gm 🌞 ' },
      { kind: 'mention', fid: 3, username: 'dwr' },
      { kind: 'text', text: ' and friends' },
    ])
  })

  it('handles unsorted and repeated mention positions, and ignores ones outside the text', () => {
    const segs = castSegments({ text: 'ab', mentions: [{ fid: 2, pos: 2 }, { fid: 1, pos: 0 }, { fid: 9, pos: 99 }] as never })
    expect(segs.filter(s => s.kind === 'mention').map(s => (s as { fid: number }).fid)).toEqual([1, 2])
  })

  it('links only http(s) URLs and trims trailing punctuation, quotes and Unicode closers', () => {
    expect(links('see https://example.com/a. ok')).toEqual(['https://example.com/a'])
    expect(links('“https://x.com/a”')).toEqual(['https://x.com/a'])
    expect(links('wow https://x.com/a… nice。')).toEqual(['https://x.com/a'])
    expect(links('not javascript:alert(1) or ftp://x')).toEqual([])
  })

  it('keeps a closing parenthesis that the URL itself opened', () => {
    expect(links('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)'])
    expect(links('(see https://x.com/a)')).toEqual(['https://x.com/a'])
  })

  it('finds channel references but not paths', () => {
    expect(channels('on /base, and /farcaster')).toEqual(['base', 'farcaster'])
    expect(channels('cd /usr/bin')).toEqual([])
    expect(channels('1/2 and https://x.com/base')).toEqual([])
  })

  it('formats relative times', () => {
    expect(relativeTime(1_000, 1_030)).toBe('now')
    expect(relativeTime(1_000, 1_000 + 3_700)).toBe('1h')
  })
})
