import { describe, expect, it } from 'vitest'

import type { ConstraintStrategy } from '../constraints/constraints.js'
import { ErrConfiguration } from '../error/common.js'
import { ErrHTTPBadRequest } from '../error/http.js'
import { findMyWayMatcher, preflightTable, starParameterRefusal } from './find_my_way.js'
import { DEFAULT_ROUTER_FLAGS, ErrRouteConflict, type RouterFlags } from './matcher.js'

function matcher(flags: Partial<RouterFlags> = {}) {
  return findMyWayMatcher<string>({ ...DEFAULT_ROUTER_FLAGS, ...flags }, [])
}

/** An exact-match strategy: routes register under a string, a request derives it from `x-flavor`. */
function flavorStrategy(): ConstraintStrategy {
  return {
    name: 'flavor',
    mustMatchWhenDerived: true,
    storage() {
      const stores = new Map<string, unknown>()
      return {
        get: value => stores.get(value) ?? null,
        set: (value, store) => void stores.set(value, store),
      }
    },
    deriveConstraint: req => req.header('x-flavor'),
  }
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

  it('selects a route by a custom strategy handed to the factory', () => {
    const m = findMyWayMatcher<string>(DEFAULT_ROUTER_FLAGS, [flavorStrategy()])
    m.add('GET', '/d', { flavor: 'spicy' }, 'S')
    m.add('GET', '/d', { flavor: 'mild' }, 'M')

    expect(m.match('GET', '/d', { flavor: 'mild' })!.store).toBe('M')
    expect(m.match('GET', '/d', {})).toBe(null)
  })

  // find-my-way marks the strategy it is given: the caller's own object is never the one it marks.
  it('takes a frozen strategy', () => {
    const m = findMyWayMatcher<string>(DEFAULT_ROUTER_FLAGS, [Object.freeze(flavorStrategy())])
    m.add('GET', '/d', { flavor: 'spicy' }, 'S')

    expect(m.match('GET', '/d', { flavor: 'spicy' })!.store).toBe('S')
  })

  // find-my-way writes a strategy's name into the code it generates.
  it('refuses a strategy name that is not an identifier', () => {
    const build = () => findMyWayMatcher<string>(DEFAULT_ROUTER_FLAGS, [{ ...flavorStrategy(), name: 'x-tenant' }])

    expect(build).toThrow(ErrConfiguration)
    expect(build).toThrow('Cannot use the constraint strategy "x-tenant": its name is not a JavaScript identifier')
  })

  it('names the constraints of a route taken twice under them', () => {
    const m = matcher()
    m.add('GET', '/v', { version: '1.0.0' }, 'A')

    const again = () => m.add('GET', '/v', { version: '1.0.0' }, 'B')

    expect(again).toThrow(ErrRouteConflict)
    expect(again).toThrow(
      'Cannot register "GET /v" for version "1.0.0": a route with this method, path and constraints is already registered',
    )
  })

  // JSON writes a pattern as `{}`, which names nothing the reader can search for.
  it('names a host pattern a route is taken twice under', () => {
    const m = matcher()
    const host = /.*\.example$/
    m.add('GET', '/h', { host }, 'A')

    expect(() => m.add('GET', '/h', { host }, 'B')).toThrow('Cannot register "GET /h" for host "/.*\\.example$/"')
  })

  // find-my-way gives such a parameter the wildcard's name: whoever reads params['*'] could not tell the two apart.
  describe('a parameter named *', () => {
    it('is refused, naming the route', () => {
      const add = () => matcher().add('GET', '/assets/:*', undefined, 'x')

      expect(add).toThrow(ErrConfiguration)
      expect(add).toThrow('a parameter named "*" reads as a wildcard, whose value has that name')
      expect(add).toThrow('"/assets/:*"')
    })

    it.each(['/:*', '/a/:x-:*', '/a/:*?'])('is refused in %s', url => {
      expect(() => matcher().add('GET', url, undefined, 'x')).toThrow(ErrConfiguration)
    })

    it('leaves a wildcard and a named parameter alone', () => {
      expect(() => matcher().add('GET', '/assets/:name/*', undefined, 'x')).not.toThrow()
    })

    it.each(['*tail', 'name:*'])('serves a route with the distinct parameter name %s', name => {
      const m = matcher()
      m.add('GET', `/assets/:${name}`, undefined, 'x')

      expect(m.match('GET', '/assets/report.txt', undefined)?.params[name]).toBe('report.txt')
    })

    // An escaped colon is text, and a parameter's regular expression is the parameter's, whatever it holds.
    it.each([['/a::*'], ['/files/:name(^[a-z]+:*$)'], ['/files/:name(^\\(:*\\)$)']])(
      'reads no parameter named * in %s',
      url => {
        expect(starParameterRefusal(url)).toBe(undefined)
      },
    )
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

// What a preflight finds: every route of a method and path, whatever constraints set them apart.
describe('preflightTable', () => {
  it('files routes find-my-way takes for one together, whatever their parameter names', () => {
    const table = preflightTable<string>(DEFAULT_ROUTER_FLAGS)
    table.add('GET', '/pets/:id', 'a')
    table.add('GET', '/pets/:petId', 'b')

    expect(table.match('GET', '/pets/7')).toEqual(['a', 'b'])
  })

  it('files paths of another case together under caseSensitive: false', () => {
    const table = preflightTable<string>({ ...DEFAULT_ROUTER_FLAGS, caseSensitive: false })
    table.add('GET', '/Pets', 'a')
    table.add('GET', '/pets', 'b')

    expect(table.match('GET', '/PETS')).toEqual(['a', 'b'])
  })

  // `findRoute` reads a path as written: the table rewrites it as `on` does before looking it up.
  it.each<[string, Partial<RouterFlags>, string, string, string]>([
    ['an optional parameter', {}, '/users', '/users/:id?', '/users'],
    ['duplicate slashes', { ignoreDuplicateSlashes: true }, '/a/b', '/a//b', '/a/b'],
    ['a trailing slash', { ignoreTrailingSlash: true }, '/a', '/a/', '/a'],
  ])('files a route under %s with the route it shares a path with', (_what, flags, first, second, url) => {
    const table = preflightTable<string>({ ...DEFAULT_ROUTER_FLAGS, ...flags })
    table.add('GET', first, 'a')
    table.add('GET', second, 'b')

    expect(table.match('GET', url)).toEqual(['a', 'b'])
  })

  it('finds nothing for a method no route of the path serves', () => {
    const table = preflightTable<string>(DEFAULT_ROUTER_FLAGS)
    table.add('GET', '/pets/:id', 'a')

    expect(table.match('POST', '/pets/7')).toBe(undefined)
  })

  it('finds nothing for a path that cannot be decoded', () => {
    const table = preflightTable<string>(DEFAULT_ROUTER_FLAGS)
    table.add('GET', '/:p', 'p')

    expect(table.match('GET', '/%E0%A4%A')).toBe(undefined)
  })
})
