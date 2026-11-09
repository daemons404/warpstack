import { createContractClientFactory, type AnyContractProcedure } from '@orpc/contract'
import { COMMON_ERROR_STATUS_MAP } from '@orpc/client'
import { OpenAPIGenerator } from '@orpc/openapi'
import { OpenAPIHandler, OpenAPILink } from '@orpc/openapi/fetch'
import { implement, walkProcedureContractsSync } from '@orpc/server'
import { SmartCoercionHandlerPlugin } from '@orpc/json-schema'
import { parseCastHash, parseChannelKey, parseFname } from '@warpstack/protocol'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  CastHash, ChannelKey, CONTRACT_VERSION, ERROR_STATUS, Fname, cacheControlOf, contract, getFacts, openEnum, openUnion, registry, SessionChallenge,
  type Facts,
} from './index.ts'

const procedures = () => {
  const out: { path: string; procedure: AnyContractProcedure }[] = []
  walkProcedureContractsSync(contract, (procedure, path) => { out.push({ path: path.join('.'), procedure: procedure as AnyContractProcedure }) })
  return out
}
const facts = (p: AnyContractProcedure) => getFacts(p) as Facts

describe('route facts', () => {
  it('every route has its facts, a path under /api/, and every {param} is an input field', () => {
    const seen = new Set<string>()
    for (const { path, procedure } of procedures()) {
      const f = facts(procedure)
      expect(f, path).toBeDefined()
      expect(f.path.startsWith('/api/'), path).toBe(true)
      expect(seen.has(f.path), `${path}: duplicate path ${f.path}`).toBe(false)
      seen.add(f.path)
      const input = procedure['~orpc'].inputSchemas?.[0] as z.ZodObject | undefined
      for (const [, param] of f.path.matchAll(/\{(\w+)\}/g)) {
        expect(input?.shape[param!], `${path}: {${param}} missing from input`).toBeDefined()
      }
    }
  })

  it('derives Cache-Control from auth and freshness, so a private answer can never be marked shared', () => {
    expect(cacheControlOf({ kind: 'read', auth: 'none', fresh: '30s' })).toBe('public, max-age=30, stale-while-revalidate=30')
    expect(cacheControlOf({ kind: 'read', auth: 'session', fresh: '30s' })).toBe('private, max-age=30')
    expect(cacheControlOf({ kind: 'read', auth: 'none', fresh: '0s' })).toBe('no-store')
    expect(cacheControlOf({ kind: 'write', auth: 'none', fresh: '1h' })).toBe('no-store')
  })

  it('session routes are private and can refuse; viewer-scoped answers come only from session routes', () => {
    for (const { path, procedure } of procedures()) {
      const f = facts(procedure)
      const errs = Object.keys(procedure['~orpc'].errorMap)
      if (f.auth !== 'none') expect(errs, path).toContain('UNAUTHORIZED')
      if (f.auth === 'session' && f.kind === 'read') expect(cacheControlOf(f), path).not.toMatch(/^public/)
      if (f.auth === 'none' && f.kind === 'read') {
        // A shared answer can't carry viewer state.
        const out = JSON.stringify(z.toJSONSchema(procedure['~orpc'].outputSchemas?.[0] as z.ZodType, { metadata: registry, unrepresentable: 'any' }))
        for (const id of ['ViewerReactions', 'ViewerLinks']) expect(out, path).not.toContain(id)
      }
    }
    expect(facts(contract.session.challenge as unknown as AnyContractProcedure).auth).toBe('none')
    expect(facts(contract.signer.registration as unknown as AnyContractProcedure).auth).toBe('none')
    expect(facts(contract.feed.following as unknown as AnyContractProcedure).auth).toBe('session')
    expect(facts(contract.messages.status as unknown as AnyContractProcedure).auth).toBe('session')
  })

  it('never lets a server name the origin the app key signs', () => {
    expect(Object.keys(SessionChallenge.shape).sort()).toEqual(['challenge', 'expiresAt', 'nonce'])
  })

  it('paged routes can return CURSOR_INVALID and upstream routes UPSTREAM_UNAVAILABLE', () => {
    for (const { path, procedure } of procedures()) {
      const f = facts(procedure)
      const errs = Object.keys(procedure['~orpc'].errorMap)
      expect(errs, path).toEqual(expect.arrayContaining(['RATE_LIMITED', 'BAD_INPUT']))
      if (f.paged) expect(errs, path).toContain('CURSOR_INVALID')
      if (f.cost === 'upstream') expect(errs, path).toContain('UPSTREAM_UNAVAILABLE')
      for (const e of errs) expect(ERROR_STATUS[e as keyof typeof ERROR_STATUS], e).toBeGreaterThan(0)
    }
  })
})

/** Walks a JSON Schema for keywords the dialect forbids or that hide a rule from the compatibility check. */
const dialectViolations = (schema: unknown, at = '$'): string[] => {
  if (schema === null || typeof schema !== 'object') return []
  const out: string[] = []
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'default') out.push(`${at}: default`)
    out.push(...dialectViolations(v, `${at}.${k}`))
  }
  return out
}

describe('the wire dialect', () => {
  it('every input and output converts to JSON Schema with no unrepresentable parts', () => {
    for (const { path, procedure } of procedures()) {
      for (const s of [...(procedure['~orpc'].inputSchemas ?? []), ...(procedure['~orpc'].outputSchemas ?? [])]) {
        const json = z.toJSONSchema(s as z.ZodType, { unrepresentable: 'throw', io: 'output' })
        expect(dialectViolations(json), path).toEqual([])
      }
    }
  })

  it('read inputs are flat: scalars and arrays of scalars, because they travel in a query string', () => {
    for (const { path, procedure } of procedures()) {
      const json = z.toJSONSchema(procedure['~orpc'].inputSchemas![0] as z.ZodType, { io: 'input' }) as { properties?: Record<string, { type?: string; items?: { type?: string } }> }
      for (const [name, prop] of Object.entries(json.properties ?? {})) {
        const t = prop.type === 'array' ? prop.items?.type : prop.type
        expect(['string', 'number', 'integer', 'boolean'], `${path}.${name}`).toContain(t)
      }
    }
  })

  it('keeps the contract patterns in step with protocol\'s parsers', () => {
    const cases: [z.ZodType, (s: string) => { ok: boolean }, fc.Arbitrary<string>][] = [
      [Fname, parseFname, fc.oneof(fc.stringMatching(/^[a-z0-9-.]{0,20}$/), fc.constantFrom('dwr', 'dwr.eth', 'a.base.eth', '-x', 'x.eth.', 'X'))],
      [ChannelKey, parseChannelKey, fc.stringMatching(/^[a-zA-Z0-9-]{0,34}$/)],
      [CastHash, parseCastHash, fc.oneof(fc.stringMatching(/^0x[0-9a-f]{40}$/), fc.stringMatching(/^0x[0-9a-fA-F]{38,42}$/))],
    ]
    for (const [schema, parse, arb] of cases) {
      fc.assert(fc.property(arb, s => {
        // The contract is strict on the wire (lowercase only); protocol's parser also normalizes.
        if (schema.safeParse(s).success) expect(parse(s).ok).toBe(true)
      }))
    }
  })

  it('open enums and unions accept a value a newer server adds, and closed ones don\'t', () => {
    const e = openEnum(['a', 'b'])
    expect(e.parse('a')).toBe('a')
    expect(e.parse('c')).toBe('c')
    const u = openUnion([z.object({ kind: z.literal('url'), url: z.string() })])
    expect(u.parse({ kind: 'video', src: 'x' })).toEqual({ kind: 'video' })
    // A known kind never falls through to the unknown branch when malformed.
    expect(u.safeParse({ kind: 'url' }).success).toBe(false)
    expect(z.enum(['a']).safeParse('c').success).toBe(false)
  })

  it('names every entity in the registry, so OpenAPI gets components', () => {
    const ids = [...(registry as unknown as { _idmap: Map<string, unknown> })._idmap.keys()]
    expect(ids).toEqual(expect.arrayContaining(['Cast', 'User', 'UserSummary', 'Channel', 'CastOrTombstone', 'Capabilities']))
  })
})

describe('OpenAPI', () => {
  it('documents every route with its facts as extensions', async () => {
    const doc = await new OpenAPIGenerator().generate(contract, { errorStatusMap: ERROR_STATUS })
    const op = (doc.paths?.['/api/casts/{fid}/{hash}'] as Record<string, Record<string, unknown>>).get
    expect(op?.['x-warpstack-auth']).toBe('none')
    expect(op?.['x-warpstack-fresh']).toBe('30s')
    expect(Object.keys(doc.paths ?? {}).sort()).toMatchSnapshot()
    const submit = (doc.paths?.['/api/messages'] as Record<string, Record<string, unknown>>).post
    expect(submit?.['x-warpstack-auth']).toBe('message')
    expect(cacheControlOf(facts(contract.messages.submit as unknown as AnyContractProcedure))).toBe('no-store')
  })

  // The whole contract, every route's inputs, outputs, errors and facts, as the OpenAPI document
  // a client or a reviewer reads. Any change to it shows here as a diff: a breaking one fails
  // until someone accepts it on purpose (`vitest -u`) and bumps CONTRACT_VERSION.
  it('matches the reviewed snapshot of every schema', async () => {
    const doc = await new OpenAPIGenerator().generate(contract, { errorStatusMap: ERROR_STATUS, base: { info: { title: 'Warpstack API', version: CONTRACT_VERSION } } })
    await expect(`${JSON.stringify(doc, null, 2)}\n`).toMatchFileSnapshot('./__snapshots__/openapi.json')
  })
})

// S3: routes end to end on the pinned oRPC v2 beta, through the REST handler, smart
// coercion of path and query values, and the link the client uses.
describe('S3: oRPC v2 end to end', () => {
  const cast = {
    hash: '0x08dff1c49e3fb82e7937ae7c8c708a8ab6da07a2', fid: 1011600, ts: 1_793_000_000, type: 'cast',
    text: 'gm', embeds: [{ kind: 'url', url: 'https://example.com/a.png' }], mentions: [],
    counts: { replies: 0, likes: 2, recasts: 0, exact: true },
    author: { fid: 1011600, pro: false },
  }
  const os = implement(contract)
  const router = os.router({
    cast: {
      get: os.cast.get.handler(({ input, errors }) => {
        if ((input.hash as string) !== cast.hash) throw errors.NOT_FOUND()
        return { cast: { state: 'live', cast: structuredClone(cast) }, rev: 7 } as never
      }),
    },
    user: {
      bulk: os.user.bulk.handler(({ input }) => ({ users: input.fids.map(fid => ({ fid, pro: false })), rev: 7 } as never)),
    },
    feed: {
      user: os.feed.user.handler(({ input }) => ({ items: [], next: { kind: 'end' }, rev: input.replies ? 1 : 0 } as never)),
    },
  } as never)
  const handler = new OpenAPIHandler(router, { errorStatusMap: { ...COMMON_ERROR_STATUS_MAP, ...ERROR_STATUS }, plugins: [new SmartCoercionHandlerPlugin()] })
  const fetchViaHandler = async (input: RequestInfo | URL, init?: RequestInit) => {
    const { response } = await handler.handle(new Request(input, init), { context: {} })
    return response ?? new Response('not found', { status: 404 })
  }
  const link = new OpenAPILink(contract, { origin: 'http://local.test', url: '/', fetch: (url, init) => fetchViaHandler(url, init) })
  const api = createContractClientFactory(link)(contract)

  it('serves GET /api/casts/{fid}/{hash}, coercing the FID from the path', async () => {
    const res = await fetchViaHandler(new Request(`http://local.test/api/casts/1011600/${cast.hash}`))
    expect(res.status).toBe(200)
    const got = await api.cast.get({ fid: 1011600 as never, hash: cast.hash as never })
    expect(got.cast.state === 'live' && got.cast.cast.text).toBe('gm')
  })

  it('coerces query arrays and booleans', async () => {
    const bulk = await fetchViaHandler(new Request('http://local.test/api/users?fids=1&fids=3'))
    expect(((await bulk.json()) as { users: { fid: number }[] }).users.map(u => u.fid)).toEqual([1, 3])
    const feed = await fetchViaHandler(new Request('http://local.test/api/users/3/feed?replies=true'))
    expect(((await feed.json()) as { rev: number }).rev).toBe(1)
  })

  it('returns a typed NOT_FOUND with its status', async () => {
    await expect(api.cast.get({ fid: 1 as never, hash: `0x${'0'.repeat(40)}` as never })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await fetchViaHandler(new Request(`http://local.test/api/casts/1/0x${'0'.repeat(40)}`))).status).toBe(404)
  })

  it('refuses input that fails its schema before the handler runs', async () => {
    expect((await fetchViaHandler(new Request('http://local.test/api/casts/0/0xnothex'))).status).toBe(400)
    expect((await fetchViaHandler(new Request('http://local.test/api/casts/1.5/0x' + '0'.repeat(40)))).status).toBe(400)
  })
})
