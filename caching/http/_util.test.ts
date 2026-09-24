import {
  ErrConfiguration,
  kRouteConstraints,
  type AdapterReply,
  type AdapterRequest,
  type AdapterRouteOptions,
} from '@caffeinejs/http'
import { describe, expect, it } from 'vitest'

import {
  applyStoredHeaders,
  assertConstraintsKeyed,
  assertTags,
  buildCacheControl,
  buildCacheKey,
  defaultCacheKey,
  durationSeconds,
  generateETag,
  isNotModified,
  matchesETag,
  parseRequestCacheControl,
  pragmaNoCache,
  storedHeadersOf,
} from './_util.js'

const request = (headers: Record<string, string>): AdapterRequest => ({ headers }) as unknown as AdapterRequest

describe('parseRequestCacheControl', () => {
  it('reads nothing from an absent header, and hands back one shared object for it', () => {
    expect(parseRequestCacheControl(undefined)).toBe(parseRequestCacheControl(undefined))
    expect(parseRequestCacheControl(undefined)).toEqual({
      noCache: false,
      noStore: false,
      onlyIfCached: false,
      maxAge: undefined,
      minFresh: undefined,
    })
  })

  // RFC 9111 §5.2: directive names are case-insensitive. A client that writes `No-Cache` means it.
  it('reads directive names whatever their case', () => {
    const parsed = parseRequestCacheControl('No-Cache, NO-STORE, Only-If-Cached, MAX-AGE=5')

    expect(parsed).toEqual({ noCache: true, noStore: true, onlyIfCached: true, maxAge: 5, minFresh: undefined })
  })

  it('reads a quoted max-age, and tolerates spaces around the list', () => {
    expect(parseRequestCacheControl(' max-age="30" , no-cache ').maxAge).toBe(30)
    expect(parseRequestCacheControl('max-age=0').maxAge).toBe(0)
  })

  it('reads a max-age that is not a number as absent', () => {
    expect(parseRequestCacheControl('max-age=soon').maxAge).toBeUndefined()
    expect(parseRequestCacheControl('max-age=-1').maxAge).toBeUndefined()
  })

  // RFC 9111 §5.2.1.3: the client wants the response to stay fresh for at least that long.
  it('reads max-stale as whole seconds, the bare directive as any age, and ignores a value that is not a number', () => {
    expect(parseRequestCacheControl('max-stale=30').maxStale).toBe(30)
    expect(parseRequestCacheControl('max-stale').maxStale).toBe(Infinity)
    expect(parseRequestCacheControl('Max-Stale="5", max-age=60').maxStale).toBe(5)
    expect(parseRequestCacheControl('max-stale=later').maxStale).toBeUndefined()
    expect(parseRequestCacheControl('no-cache').maxStale).toBeUndefined()
  })

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

describe('pragmaNoCache', () => {
  it('stands in for no-cache on a request without Cache-Control', () => {
    expect(pragmaNoCache(request({ pragma: 'No-Cache' }))).toBe(true)
  })

  // RFC 9111 §5.4: Cache-Control, when present, is the whole answer.
  it('is ignored next to a Cache-Control header', () => {
    expect(pragmaNoCache(request({ pragma: 'no-cache', 'cache-control': 'max-age=60' }))).toBe(false)
  })
})

describe('matchesETag', () => {
  it('compares weakly, in both directions', () => {
    expect(matchesETag('W/"abc"', '"abc"')).toBe(true)
    expect(matchesETag('"abc"', 'W/"abc"')).toBe(true)
    expect(matchesETag('"abd"', '"abc"')).toBe(false)
  })

  it('finds the tag in a list, and matches anything for *', () => {
    expect(matchesETag('"x", W/"abc" ,"y"', '"abc"')).toBe(true)
    expect(matchesETag('*', '"abc"')).toBe(true)
  })

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

  it('lets If-None-Match decide alone when it is present', () => {
    const headers = { 'if-none-match': '"other"', 'if-modified-since': 'Tue, 02 Jan 2024 00:00:00 GMT' }

    expect(isNotModified(request(headers), '"abc"', lastModified)).toBe(false)
  })

  it('falls back to If-Modified-Since without it', () => {
    expect(isNotModified(request({ 'if-modified-since': lastModified }), '"abc"', lastModified)).toBe(true)
    expect(
      isNotModified(request({ 'if-modified-since': 'Sun, 31 Dec 2023 00:00:00 GMT' }), '"abc"', lastModified),
    ).toBe(false)
  })

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

describe('durationSeconds', () => {
  const route = { method: 'GET', url: '/pets' } as unknown as AdapterRouteOptions

  // `max-age` is whole seconds: a ttl of 400ms would be sent as `max-age=0`.
  it('refuses a ttl below one second, and takes a stale window of zero', () => {
    expect(() => durationSeconds(route, 'ttl', '400ms', 1)).toThrow(ErrConfiguration)
    expect(() => durationSeconds(route, 'ttl', 0.999, 1)).toThrow('ttl must be at least one second')
    expect(durationSeconds(route, 'ttl', 1, 1)).toBe(1)
    expect(durationSeconds(route, 'staleIfError', 0, 0)).toBe(0)
    expect(() => durationSeconds(route, 'staleIfError', -1, 0)).toThrow('staleIfError must be a non-negative duration')
  })
})

describe('assertTags', () => {
  const route = { method: 'POST', url: '/pets' } as unknown as AdapterRouteOptions

  it('wants at least one tag where tags are required, and takes none where they are not', () => {
    expect(() => assertTags(route, undefined, { what: 'cache invalidation', required: true })).toThrow(
      'Cannot install cache invalidation on "POST /pets": tags must name at least one tag',
    )
    expect(() => assertTags(route, [], { what: 'cache invalidation', required: true })).toThrow(ErrConfiguration)
    expect(() => assertTags(route, undefined, { what: 'caching', required: false })).not.toThrow()
    expect(() => assertTags(route, [], { what: 'caching', required: false })).not.toThrow()
  })

  // A brace in a key decides its slot on a Redis cluster; an empty tag names nothing.
  it('refuses a tag that is empty, not a string, or holds a brace', () => {
    for (const tag of ['', 42, '{a}', 'a}']) {
      expect(() => assertTags(route, [tag], { what: 'caching', required: false })).toThrow(
        `Cannot install caching on "POST /pets": a tag must be a non-empty string without "{" or "}", got "${String(tag)}"`,
      )
    }
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
  // The tag is what clients already hold: changing how it is computed must not change what it is.
  it('hashes a payload to the strong tag it always had', async () => {
    expect(await generateETag('abc')).toBe('"a9993e364706816a"')
    expect(await generateETag(Buffer.from('abc'))).toBe('"a9993e364706816a"')
  })

  it('hands the bytes to a custom generator and uses what it returns', async () => {
    expect(await generateETag('abc', buf => `W/"${buf.length}"`)).toBe('W/"3"')
  })
})

// A route served under a base path answers two URLs: `/api/x` through the gateway and `/x` straight to the
// application. What it renders may link under the base, so the two must not share an entry.
describe('defaultCacheKey under a base path', () => {
  const at = (url: string, basePath?: string): AdapterRequest =>
    ({
      method: 'GET',
      url,
      headers: {},
      ...(basePath === undefined ? {} : { httpContext: { req: { basePath } } }),
    }) as unknown as AdapterRequest

  it('keys a request by the URL the browser asked for, base path included', () => {
    expect(defaultCacheKey(at('/x', '/api'))).not.toBe(defaultCacheKey(at('/x', '')))
    expect(defaultCacheKey(at('/x', '/api'))).toBe(defaultCacheKey(at('/api/x', '')))
  })

  it('keys a request with no base path by its URL alone, as it always has', () => {
    expect(defaultCacheKey(at('/x', ''))).toBe(defaultCacheKey(at('/x')))
    expect(defaultCacheKey(at('/x'))).toBe(buildCacheKey('GET', '/x', undefined, () => undefined))
  })
})
