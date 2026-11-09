import { describe, expect, it } from 'vitest'
import { draftProblem, prepareCast } from './compose.ts'

const resolve = async (n: string) => ({ bob: 2, 'alice.eth': 3 } as Record<string, number>)[n] ?? null

describe('prepareCast', () => {
  it('takes resolved mentions out of the text at their UTF-8 byte positions', async () => {
    const b = await prepareCast({ text: 'hé @bob and @Alice.eth, not @nobody' }, resolve)
    expect(b.text).toBe('hé  and , not @nobody')
    expect(b.mentions).toEqual([2, 3])
    // "hé " is 4 bytes; "hé  and " is 9.
    expect(b.mentionsPositions).toEqual([4, 9])
  })

  it('resolves a mention at the end of a sentence', async () => {
    const b = await prepareCast({ text: 'gm @bob. and @alice.eth.' }, resolve)
    expect(b.mentions).toEqual([2, 3])
    expect(b.text).toBe('gm . and .')
  })

  it('leaves emails and mid-word @ alone', async () => {
    const b = await prepareCast({ text: 'mail bob@bob.com' }, resolve)
    expect(b.mentions).toEqual([])
    expect(b.text).toBe('mail bob@bob.com')
  })

  it('embeds a quote first, then up to two links', async () => {
    const quote = { fid: 9, hash: `0x${'ab'.repeat(20)}` }
    const b = await prepareCast({ text: 'see https://a.com/x. and https://b.com and https://c.com', quote }, resolve)
    expect(b.embeds).toEqual([{ cast: quote }, { url: 'https://a.com/x' }])
    const c = await prepareCast({ text: 'https://a.com https://b.com https://c.com' }, resolve)
    expect(c.embeds).toEqual([{ url: 'https://a.com' }, { url: 'https://b.com' }])
  })

  it('carries a reply or channel parent', async () => {
    expect((await prepareCast({ text: 'x', parent: { url: 'https://warpcast.com/~/channel/dev' } }, resolve)).parent).toEqual({ url: 'https://warpcast.com/~/channel/dev' })
  })
})

describe('attachments', () => {
  const quote = { fid: 7, hash: `0x${'a'.repeat(40)}` } as never
  const img = (n: number) => `https://media.test/img/u/${n}.webp`

  it('refuses more images and quotes than a cast holds, before anything is uploaded or signed', async () => {
    expect(draftProblem({ images: [img(1)], quote })).toBeNull()
    expect(draftProblem({ images: [img(1), img(2)], quote })).toMatch(/at most 2/)
    await expect(prepareCast({ text: 'hi', images: [img(1), img(2)], quote }, async () => null)).rejects.toThrow(RangeError)
  })

  it('lets links in the text take only the room that is left', async () => {
    const body = await prepareCast({ text: 'see https://a.test and https://b.test', images: [img(1)] }, async () => null)
    expect(body.embeds).toEqual([{ url: img(1) }, { url: 'https://a.test' }])
  })
})
