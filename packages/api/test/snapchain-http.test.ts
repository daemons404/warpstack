import { describe, expect, it } from 'vitest'
import { HttpSnapchain, liveToken } from '../src/adapters/snapchain-http.ts'

describe('Snapchain page tokens', () => {
  it('treats an all-null cross-shard token as the end of the list', () => {
    expect(liveToken('W251bGwsbnVsbF0=')).toBeUndefined() // [null,null], recorded from the public node
    expect(liveToken(btoa('[[1,2],null]'))).toBe(btoa('[[1,2],null]'))
    expect(liveToken('AwAAAAMBCuR2IOwMiiJ9fzStPiJDrgmLRkWbfRhH')).toBe('AwAAAAMBCuR2IOwMiiJ9fzStPiJDrgmLRkWbfRhH')
    expect(liveToken(null)).toBeUndefined()
  })

  it('returns no next page when the node says every shard is done', async () => {
    const node = new HttpSnapchain({ url: 'https://node.test' }, async () =>
      new Response(JSON.stringify({ messages: [], nextPageToken: 'W251bGwsbnVsbF0=' })))
    const r = await node.castsByParent({ fid: 1, hash: `0x${'1'.repeat(40)}` }, { size: 12, reverse: false })
    expect(r).toEqual({ ok: true, value: { messages: [], next: undefined } })
  })
})

describe('event pages', () => {
  it('skips an event that fails to parse, counts it, and still reports its ID', async () => {
    const { parseEvents } = await import('../src/adapters/snapchain-http.ts')
    const page = parseEvents([
      { type: 'HUB_EVENT_TYPE_BLOCK_CONFIRMED', id: 10, blockConfirmedBody: { blockNumber: 1, timestamp: 5 } },
      { type: 'HUB_EVENT_TYPE_MERGE_MESSAGE', id: 11, mergeMessageBody: { message: { hash: 'no data' } } },
    ])
    expect(page.events).toHaveLength(1)
    expect(page.skipped).toBe(1)
    expect(page.lastId).toBe(11)
  })

  it('splits an Access token at its first colon only', async () => {
    let seen: Headers | undefined
    const node = new HttpSnapchain({ url: 'https://node.test', accessToken: 'id.access:se:cret' }, async (_u, init) => {
      seen = new Headers(init?.headers)
      return new Response(JSON.stringify({ messages: [] }))
    })
    await node.userData(1 as never)
    expect(seen?.get('cf-access-client-id')).toBe('id.access')
    expect(seen?.get('cf-access-client-secret')).toBe('se:cret')
  })
})

describe('M1.5 node calls', () => {
  it('posts a message as octet-stream and reads the node\'s refusal as plain text', async () => {
    let seen: { url: string; init?: RequestInit } | undefined
    const ok = new HttpSnapchain({ url: 'https://node.test' }, async (u, init) => {
      seen = { url: String(u), init }
      return new Response(JSON.stringify({ hash: `0x${'AB'.repeat(20)}`, data: {} }))
    })
    expect(await ok.submitMessage(new Uint8Array([1, 2]))).toEqual({ ok: true, value: { hash: `0x${'ab'.repeat(20)}` } })
    expect(seen?.url).toBe('https://node.test/v1/submitMessage')
    expect(new Headers(seen?.init?.headers).get('content-type')).toBe('application/octet-stream')

    const refused = new HttpSnapchain({ url: 'https://node.test' }, async () => new Response(JSON.stringify({
      error: 'Failed to submit message',
      error_detail: 'status: InvalidArgument, message: "bad_request.validation_failure/invalid signer\u001b[31m", details: []',
    }), { status: 400 }))
    expect(await refused.submitMessage(new Uint8Array([1]))).toEqual({ ok: false, error: { kind: 'rejected', detail: 'bad_request.validation_failure/invalid signer' } })

    const down = new HttpSnapchain({ url: 'https://node.test' }, async () => new Response('', { status: 503 }))
    expect((await down.submitMessage(new Uint8Array([1]))).ok).toBe(false)
  })

  it('reads signers and nonces, and the latest custody owner, as recorded from the public node', async () => {
    const node = new HttpSnapchain({ url: 'https://node.test' }, async u => {
      const path = new URL(String(u)).pathname
      if (path === '/v1/signersByFid') {
        expect(new URL(String(u)).searchParams.get('requesterFids[]')).toBe('1234')
        return new Response(JSON.stringify({
          signers: [
            { source: 'SIGNER_SOURCE_ONCHAIN', key: `0x${'cf'.repeat(32)}`, keyType: 1, fid: 1234, addedAt: 1699396749 },
            { source: 'SIGNER_SOURCE_OFFCHAIN', key: `0x${'01'.repeat(32)}`, keyType: 1, fid: 1234, addedAt: 150_000_000, expiresAt: 152_592_000, scopes: ['MESSAGE_TYPE_CAST_ADD', 'MESSAGE_TYPE_FUTURE'], requestFid: 1234 },
          ],
          gaslessSignerCount: 1, gaslessSignerLimit: 1000, currentUserNonce: 3, requesterFidNonces: { 1234: 1 },
        }))
      }
      return new Response(JSON.stringify({ events: [
        { type: 'EVENT_TYPE_ID_REGISTER', blockNumber: 111893992, logIndex: 178, fid: 1234, idRegisterEventBody: { to: '0xa8509291bbac87ac4f14be0606efcaea2665b5e4', eventType: 'Register', from: '0x', recoveryAddress: '0x00000000fcb080a4d6c39a9354da9eb9bc104cd7' } },
        { type: 'EVENT_TYPE_ID_REGISTER', blockNumber: 135833392, logIndex: 2, fid: 1234, idRegisterEventBody: { to: '0xE90026c9fc8b5fee2401c371acd14e3a24aedb3c', eventType: 'Transfer', from: '0xa8509291bbac87ac4f14be0606efcaea2665b5e4', recoveryAddress: '0x' } },
      ] }))
    })
    const s = await node.signers(1234 as never, [1234 as never])
    expect(s.ok && s.value.userNonce).toBe(3)
    expect(s.ok && s.value.requesterNonces.get(1234)).toBe(1)
    expect(s.ok && s.value.keys.map(k => [k.source, k.scopes, k.addedAt])).toEqual([['onchain', [], 1699396749], ['gasless', [1], 150_000_000 + 1_609_459_200]])
    expect(await node.custodyOf(1234 as never)).toEqual({ ok: true, value: '0xe90026c9fc8b5fee2401c371acd14e3a24aedb3c' })
  })
})
