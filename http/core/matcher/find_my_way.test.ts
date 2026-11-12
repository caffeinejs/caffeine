import { describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../error/common.js'
import { ErrHTTPBadRequest } from '../error/http.js'
import { findMyWayMatcher } from './find_my_way.js'
import { DEFAULT_ROUTER_FLAGS, ErrRouteConflict, type RouterFlags } from './matcher.js'

function matcher(flags: Partial<RouterFlags> = {}) {
  return findMyWayMatcher<string>({ ...DEFAULT_ROUTER_FLAGS, ...flags })
}

describe('findMyWayMatcher', () => {
  it('matches a static route and hands back its store', () => {
    const m = matcher()
    m.add('GET', '/a', undefined, 'store-a')

    expect(m.match('GET', '/a', undefined)).toEqual({ store: 'store-a', params: {}, query: '' })
  })

  // The query is parsed only when a handler reads it, so the matcher hands it on as it was sent.
  it('decodes parameters and leaves the query raw', () => {
    const m = matcher()
    m.add('GET', '/u/:id', undefined, 'user')

    const found = m.match('GET', '/u/a%20b?x=1+2', undefined)

    expect({ ...found!.params }).toEqual({ id: 'a b' })
    expect(found!.query).toBe('x=1+2')
  })

  it('matches case-insensitively under caseSensitive: false', () => {
    const m = matcher({ caseSensitive: false })
    m.add('GET', '/a', undefined, 'a')

    expect(m.match('GET', '/A', undefined)?.store).toBe('a')
  })

  it('matches a trailing slash under ignoreTrailingSlash', () => {
    const m = matcher({ ignoreTrailingSlash: true })
    m.add('GET', '/a', undefined, 'a')

    expect(m.match('GET', '/a/', undefined)?.store).toBe('a')
  })

  it('collapses // under ignoreDuplicateSlashes', () => {
    const m = matcher({ ignoreDuplicateSlashes: true })
    m.add('GET', '/a/b', undefined, 'ab')

    expect(m.match('GET', '//a//b', undefined)?.store).toBe('ab')
  })

  it('splits the query at ; under useSemicolonDelimiter', () => {
    const m = matcher({ useSemicolonDelimiter: true })
    m.add('GET', '/a', undefined, 'a')

    expect(m.match('GET', '/a;x=1', undefined)?.query).toBe('x=1')
  })

  it('registers QUERY', () => {
    const m = matcher()
    m.add('QUERY', '/q', undefined, 'q')

    expect(m.match('QUERY', '/q', undefined)?.store).toBe('q')
  })

  // What lets a GET's automatic HEAD route give way to an explicit one: the conflict is an error of its own.
  it('refuses a second route on the same method and path with ErrRouteConflict', () => {
    const m = matcher()
    m.add('GET', '/a', undefined, 'first')

    expect(() => m.add('GET', '/a', undefined, 'second')).toThrow(ErrRouteConflict)
    expect(() => m.add('GET', '/a', undefined, 'second')).toThrow('"GET /a"')
  })

  it('refuses a parameter named *', () => {
    expect(() => matcher().add('GET', '/:*', undefined, 'x')).toThrow(ErrConfiguration)
  })

  it('refuses a path not starting with / as ErrConfiguration, not an assertion', () => {
    const add = () => matcher().add('GET', 'a', undefined, 'x')

    expect(add).toThrow(ErrConfiguration)
    expect(add).not.toThrow(ErrRouteConflict)
  })

  it('refuses a method it does not know as ErrConfiguration, not a conflict', () => {
    const add = () => matcher().add('FETCH', '/a', undefined, 'x')

    expect(add).toThrow(ErrConfiguration)
    expect(add).not.toThrow(ErrRouteConflict)
  })

  it('answers a path that cannot be decoded with ErrHTTPBadRequest', () => {
    const m = matcher()
    m.add('GET', '/:p', undefined, 'p')

    expect(() => m.match('GET', '/%E0%A4%A', undefined)).toThrow(ErrHTTPBadRequest)
  })

  it('matches nothing for an unknown path', () => {
    const m = matcher()
    m.add('GET', '/a', undefined, 'a')

    expect(m.match('GET', '/b', undefined)).toBe(null)
  })
})
