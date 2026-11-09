import { describe, expect, it } from 'vitest'
import { params, routes } from './links.ts'

describe('route params', () => {
  it('accepts only canonical FIDs', () => {
    expect(params.fid('3')).toBe(3)
    for (const bad of ['0', '007', '1e3', '0x10', ' 7', '7 ', '-1', '1.5', '99999999999999999', undefined]) expect(params.fid(bad)).toBeNull()
  })

  it('accepts lowercase hashes, channel keys, and usernames with or without @', () => {
    expect(params.hash(`0x${'a'.repeat(40)}`)).toBe(`0x${'a'.repeat(40)}`)
    expect(params.hash(`0x${'A'.repeat(40)}`)).toBeNull()
    expect(params.channel('base')).toBe('base')
    expect(params.channel('assets')).toBe('assets')
    expect(params.username('@Horsefacts.eth')).toBe('horsefacts.eth')
    expect(params.username('favicon.ico')).toBeNull()
  })

  it('builds FID-based canonical links', () => {
    expect(routes.profile(3)).toBe('/profile/3')
    expect(routes.thread({ fid: 3, hash: '0xab' })).toBe('/cast/3/0xab')
    expect(routes.channel('base')).toBe('/channel/base')
  })

  it('round-trips composer parameters', () => {
    const ref = { fid: 3, hash: `0x${'a'.repeat(40)}` }
    expect(routes.compose()).toBe('/compose')
    const url = new URL(routes.compose({ reply: ref, channel: 'dev' }), 'https://x.test')
    expect(params.castRef(url.searchParams.get('reply'))).toEqual(ref)
    expect(url.searchParams.get('channel')).toBe('dev')
    expect(params.castRef('3:0xzz')).toBeNull()
    expect(params.castRef(`3:${ref.hash}:x`)).toBeNull()
  })
})
