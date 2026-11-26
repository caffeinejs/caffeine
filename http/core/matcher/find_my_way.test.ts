import FindMyWay from 'find-my-way'
import { describe, expect, it } from 'vitest'

import type { ConstraintStrategy } from '../constraints/constraints.js'
import { ErrConfiguration } from '../error/common.js'
import { ErrHTTPBadRequest } from '../error/http.js'
import { requestPath } from '../server/context.js'
import { findMyWayMatcher } from './find_my_way.js'
import { ErrRouteConflict } from './matcher.js'

function matcher() {
  return findMyWayMatcher<string>([])
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

    expect(m.match('GET', '/a', undefined)).toEqual({ store: 'store-a', params: {} })
  })

  it('matches case-sensitively', () => {
    const m = matcher()
    m.add('GET', '/a', undefined, 'a')

    expect(m.match('GET', '/A', undefined)).toBe(null)
  })

  // A trailing slash never makes another route.
  it('matches a path with a trailing slash as the path without it', () => {
    const m = matcher()
    m.add('GET', '/a', undefined, 'a')

    expect(m.match('GET', '/a/', undefined)?.store).toBe('a')
  })

  // The router reads the route syntax: what it cannot register is refused as configuration, naming the route.
  it.each(['/a/*/b', '/a/:id(\\d+'])('refuses %s as ErrConfiguration, naming the route', path => {
    const add = () => matcher().add('GET', path, undefined, 'x')

    expect(add).toThrow(ErrConfiguration)
    expect(add).toThrow(`Cannot register "GET ${path}"`)
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
    const m = findMyWayMatcher<string>([flavorStrategy()])
    m.add('GET', '/d', { flavor: 'spicy' }, 'S')
    m.add('GET', '/d', { flavor: 'mild' }, 'M')

    expect(m.match('GET', '/d', { flavor: 'mild' })!.store).toBe('M')
    expect(m.match('GET', '/d', {})).toBe(null)
  })

  // find-my-way marks the strategy it is given: the caller's own object is never the one it marks.
  it('takes a frozen strategy', () => {
    const m = findMyWayMatcher<string>([Object.freeze(flavorStrategy())])
    m.add('GET', '/d', { flavor: 'spicy' }, 'S')

    expect(m.match('GET', '/d', { flavor: 'spicy' })!.store).toBe('S')
  })

  // find-my-way writes a strategy's name into the code it generates.
  it('refuses a strategy name that is not an identifier', () => {
    const build = () => findMyWayMatcher<string>([{ ...flavorStrategy(), name: 'x-tenant' }])

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

// The matcher is handed ctx.req.path and find-my-way decodes it again: that second decoding must change nothing, so the
// router binds what it would bind from the target as sent.
describe('a path requestPath read', () => {
  const paths = ['/admin/:x', '/files/*', '/a', '/café', '/p100%']

  it.each([
    '/admin/%61b',
    '/admin/a%2Fb',
    '/admin/a%2fb',
    '/files/a%2Fb/c%20d',
    '/files/%E2%82%AC/%3F',
    '/a?x=1',
    '/%61',
    '/admin/x/',
    '/caf%C3%A9',
    '/admin/100%25',
    '/p100%25',
    '/admin/%2525',
    '/files/%2561/%252F',
    '/files/%25%32%46',
    '/admin/a%3Bb%2523',
  ])('matches %s as find-my-way matches the target as sent', target => {
    const raw = FindMyWay({ ignoreTrailingSlash: true })
    const m = matcher()
    for (const path of paths) {
      raw.on('GET', path, () => undefined, path)
      m.add('GET', path, undefined, path)
    }

    const sent = raw.find('GET', target)
    const found = m.match('GET', requestPath(target), undefined)

    expect(found === null ? null : { store: found.store, params: { ...found.params } }).toEqual(
      sent === null ? null : { store: sent.store, params: { ...sent.params } },
    )
    expect(found).not.toBe(null)
  })
})
