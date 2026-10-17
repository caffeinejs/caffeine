import { ErrConfiguration, kRouteConstraints } from '@caffeinejs/http'
import { type AdapterReply, type AdapterRequest, type AdapterRouteOptions } from '@caffeinejs/http/fastify'
import { describe, expect, it } from 'vitest'

import {
  applyStoredHeaders,
  assertConstraintsKeyed,
  buildCacheControl,
  buildCacheKey,
  generateETag,
  isNotModified,
  matchesETag,
  parseRequestCacheControl,
  storedHeadersOf,
} from './_util.js'

const request = (headers: Record<string, string>): AdapterRequest => ({ headers }) as unknown as AdapterRequest

describe('parseRequestCacheControl', () => {
  it('reads a quoted max-age, and tolerates spaces around the list', () => {
    expect(parseRequestCacheControl(' max-age="30" , no-cache ').maxAge).toBe(30)
    expect(parseRequestCacheControl('max-age=0').maxAge).toBe(0)
  })

  it('reads a max-age that is not a number as absent', () => {
    expect(parseRequestCacheControl('max-age=soon').maxAge).toBeUndefined()
    expect(parseRequestCacheControl('max-age=-1').maxAge).toBeUndefined()
  })

  // RFC 9111 §5.2.1.2: the client takes a response that much past its freshness; the bare directive, any amount.
  it('reads max-stale as whole seconds, the bare directive as any age, and ignores a value that is not a number', () => {
    expect(parseRequestCacheControl('max-stale=30').maxStale).toBe(30)
    expect(parseRequestCacheControl('max-stale').maxStale).toBe(Infinity)
    expect(parseRequestCacheControl('Max-Stale="5", max-age=60').maxStale).toBe(5)
    expect(parseRequestCacheControl('max-stale=later').maxStale).toBeUndefined()
    expect(parseRequestCacheControl('no-cache').maxStale).toBeUndefined()
  })

  // RFC 9111 §5.2.1.3: the client wants the response to stay fresh for at least that long.
  it('reads min-fresh as whole seconds, and ignores a value that is not a number', () => {
    expect(parseRequestCacheControl('min-fresh=30').minFresh).toBe(30)
    expect(parseRequestCacheControl('Min-Fresh="5", max-age=60').minFresh).toBe(5)
    expect(parseRequestCacheControl('min-fresh=soon').minFresh).toBeUndefined()
    expect(parseRequestCacheControl('min-fresh').minFresh).toBeUndefined()
  })

  it('matches a directive by its whole name, not by a substring', () => {
    const parsed = parseRequestCacheControl('x-no-cache-hint, no-store-ish=1, min-fresh=no-cache')

    expect(parsed.noCache).toBe(false)
    expect(parsed.noStore).toBe(false)
  })
})

describe('matchesETag', () => {
  // An entity-tag may hold a comma, so a list cannot be cut on commas.
  // A header that holds no entity-tag at all says nothing the server could agree with.
  it('matches nothing when the header holds no entity-tag', () => {
    expect(matchesETag('abc, def', '"abc"')).toBe(false)
    expect(matchesETag('', '"abc"')).toBe(false)
  })

  it('matches an entity-tag that contains a comma', () => {
    expect(matchesETag('"x", "a,b"', '"a,b"')).toBe(true)
    expect(matchesETag('"a,b"', '"a"')).toBe(false)
  })
})

describe('isNotModified', () => {
  const lastModified = 'Mon, 01 Jan 2024 00:00:00 GMT'

  it('ignores a date it cannot read, and a validator it was not given', () => {
    expect(isNotModified(request({ 'if-modified-since': 'yesterday' }), undefined, lastModified)).toBe(false)
    expect(isNotModified(request({ 'if-modified-since': lastModified }), undefined, undefined)).toBe(false)
    expect(isNotModified(request({ 'if-none-match': '"abc"' }), undefined, lastModified)).toBe(false)
  })
})

describe('buildCacheKey', () => {
  const noHeader = () => undefined

  // `/pets?` and `/pets` name one resource, and a query in another order is the same query.
  it('gives a URL with an empty query the key of the bare path, whatever the query order', () => {
    expect(buildCacheKey('GET', '/pets?', undefined, noHeader)).toBe(buildCacheKey('GET', '/pets', undefined, noHeader))
    expect(buildCacheKey('GET', '/pets?b=2&a=1', undefined, noHeader)).toBe(
      buildCacheKey('GET', '/pets?a=1&b=2', undefined, noHeader),
    )
  })

  // A tracking parameter must not give every visitor an entry of their own.
  it('keeps only the query parameters named in varyByQuery', () => {
    const named = new Set(['page', 'q'])

    expect(buildCacheKey('GET', '/pets?utm_source=x&page=2&q=cat', undefined, noHeader, named)).toBe(
      buildCacheKey('GET', '/pets?q=cat&page=2', undefined, noHeader),
    )
    expect(buildCacheKey('GET', '/pets?utm_source=x', undefined, noHeader, new Set())).toBe(
      buildCacheKey('GET', '/pets', undefined, noHeader),
    )
    expect(buildCacheKey('GET', '/pets?Page=2', undefined, noHeader, named)).toBe(
      buildCacheKey('GET', '/pets', undefined, noHeader),
    )
  })
})

describe('the headers kept with an entry', () => {
  const replyWith = (headers: Record<string, unknown>) => {
    const set: Record<string, unknown> = { ...headers }

    return {
      set,
      reply: {
        getHeaders: () => set,
        getHeader: (name: string) => set[name],
        hasHeader: (name: string) => set[name] !== undefined,
        header: (name: string, value: unknown) => {
          set[name] = value
        },
      } as unknown as AdapterReply,
    }
  }

  // A handler may set a header from a number. An entry travels to stores that serialize it, and is replayed
  // through an API that takes text: it is kept the way it would have gone out on the wire.
  it('keeps a numeric header as the text it goes out as, and leaves out what belongs to one response', () => {
    const { reply } = replyWith({ 'x-total-count': 42, 'content-length': 10, 'x-cache': 'MISS', link: ['a', 'b'] })

    expect(storedHeadersOf(reply, 'x-cache')).toEqual({ 'x-total-count': '42', link: ['a', 'b'] })
  })

  // RFC 9111 §3.1: a field the response's own `Connection` names belongs to that connection, whatever it is
  // called, and so does what a proxy says about its authentication.
  it('leaves out the fields Connection names, and Proxy-Authentication-Info', () => {
    const { reply } = replyWith({
      connection: 'close, X-Hop',
      'x-hop': 'one connection only',
      'proxy-authentication-info': 'nextnonce="abc"',
      'x-kept': 'yes',
    })

    expect(storedHeadersOf(reply, 'x-cache')).toEqual({ 'x-kept': 'yes' })
  })

  // `Vary` may have been stored from a list. Replaying it must add to what this request's hooks already said.
  it('merges a Vary stored as a list into the one already on the reply', () => {
    const { reply, set } = replyWith({ vary: 'Origin' })

    applyStoredHeaders(reply, { vary: ['Accept-Language', 'origin, Accept'] }, 'hit')

    expect(set.vary).toBe('Origin, Accept-Language, Accept')
  })
})

describe('assertConstraintsKeyed', () => {
  const route = (extra: Partial<AdapterRouteOptions>) =>
    ({ method: 'GET', url: '/pets', ...extra }) as unknown as AdapterRouteOptions

  // A host constraint is two sites on one URL: without `Host` in the key, one is served the other's pages.
  it('wants a host-constrained route to vary on Host', () => {
    const constrained = route({ constraints: { host: 'a.example' } })

    expect(() => assertConstraintsKeyed(constrained, { ttl: 60 })).toThrow(ErrConfiguration)
    expect(() => assertConstraintsKeyed(constrained, { ttl: 60 })).toThrow('constrained on "Host"')
    expect(() => assertConstraintsKeyed(constrained, { ttl: 60, vary: ['host'] })).not.toThrow()
  })

  // Fastify's own version constraint, written on the route with no declaration, reads `Accept-Version`.
  it('wants a route under the version constraint Fastify ships to vary on Accept-Version', () => {
    const constrained = route({ constraints: { version: '1.x' } })

    expect(() => assertConstraintsKeyed(constrained, { ttl: 60 })).toThrow('constrained on "Accept-Version"')
    expect(() => assertConstraintsKeyed(constrained, { ttl: 60, vary: ['accept-version'] })).not.toThrow()
  })

  // A custom constraint may read anything, a header or not. Nothing in `vary` can stand for it, so only a key
  // function of the route's own tells it apart.
  it('wants a key from a route under a constraint it does not know', () => {
    const constrained = route({ constraints: { tenant: 'a' } })

    expect(() => assertConstraintsKeyed(constrained, { ttl: 60, vary: ['tenant'] })).toThrow(
      'constraint "tenant" reads no header the cache key can vary on',
    )
    expect(() => assertConstraintsKeyed(constrained, { ttl: 60, key: () => 'tenant-a' })).not.toThrow()
    expect(() => assertConstraintsKeyed(constrained, { ttl: 60, key: () => 'a:pets' })).not.toThrow()
  })

  // The constraints plugin copies a declared constraint onto the route as well. The declaration knows the header
  // it reads, a custom one included, and is the one believed.
  it('reads a constraint declared with its header once, from the declaration', () => {
    const declared = new Map([['version', { header: 'X-API-Version' }]])
    const constrained = route({
      constraints: { version: '1.x' },
      config: { [kRouteConstraints]: declared } as never,
    })

    expect(() => assertConstraintsKeyed(constrained, { ttl: 60, vary: ['X-API-Version'] })).not.toThrow()
    expect(() => assertConstraintsKeyed(constrained, { ttl: 60, vary: ['Accept-Version'] })).toThrow(
      'constrained on "X-API-Version"',
    )
  })
})

describe('buildCacheControl', () => {
  // The entry is gone from the store when its ttl is up. A lifetime rounded up tells a cache downstream to keep
  // serving what the origin has already dropped.
  it('never tells a cache downstream a lifetime longer than the one given', () => {
    expect(buildCacheControl({ ttl: '1500ms' })).toBe('public, max-age=1')
    expect(
      buildCacheControl({ ttl: 2.9, sharedMaxAge: '2500ms', staleWhileRevalidate: 0.9, staleIfError: '1900ms' }),
    ).toBe('public, max-age=2, s-maxage=2, stale-while-revalidate=0, stale-if-error=1')
  })

  // RFC 9111 §4.2.4 — the store serves nothing stale under these, so a cache downstream is not told to either.
  it('announces no stale window on a route that must be revalidated', () => {
    const windows = { ttl: 60, staleWhileRevalidate: 30, staleIfError: 300 }

    expect(buildCacheControl({ ...windows, mustRevalidate: true })).toBe('public, must-revalidate, max-age=60')
    expect(buildCacheControl({ ...windows, proxyRevalidate: true })).toBe('public, proxy-revalidate, max-age=60')
    expect(buildCacheControl({ ...windows, noCache: true })).toBe('no-cache, public, max-age=60')
    expect(buildCacheControl(windows)).toBe('public, max-age=60, stale-while-revalidate=30, stale-if-error=300')
  })
})

describe('generateETag', () => {
  it('hands the bytes to a custom generator and uses what it returns', async () => {
    expect(await generateETag('abc', buf => `W/"${buf.length}"`)).toBe('W/"3"')
  })
})
