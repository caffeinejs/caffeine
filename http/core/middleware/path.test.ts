import { describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../error/common.js'
import { requestPath } from '../server/context.js'
import { placeMiddlewares, prefixMatcher } from './path.js'
import type { ResolvedMiddleware } from './pipeline.js'

const noop = (): void => undefined

describe('prefixMatcher', () => {
  // `/admin` guards `/admin/...` and must not leak onto a sibling that merely starts with the same letters.
  it('matches on a segment boundary', () => {
    const matches = prefixMatcher('/admin')

    expect([matches('/admin'), matches('/admin/users'), matches('/adminx')]).toEqual([true, true, false])
  })

  // Routes match case-sensitively, so a middleware does too: it covers what the router sends under its prefix.
  it('matches case-sensitively', () => {
    expect(prefixMatcher('/admin')('/ADMIN')).toBe(false)
  })

  it('matches an array', () => {
    const matches = prefixMatcher(['/a', '/b'])

    expect([matches('/b/x'), matches('/c')]).toEqual([true, false])
  })
})

describe('placeMiddlewares', () => {
  const middleware = (path: string | undefined): ResolvedMiddleware => ({
    path,
    hook: undefined,
    handle: noop,
  })

  // What the middleware sees of a request to one of the scope's routes, as the chain matches it.
  const matches = (base: string, path: string, url: string): boolean =>
    prefixMatcher(placeMiddlewares(base, [middleware(path)])[0]!.path!)(requestPath(url))

  it('leaves a pathless middleware covering the whole scope', () => {
    const [all] = placeMiddlewares('/admin', [middleware(undefined)])

    expect([all!.path]).toEqual([undefined])
  })

  it('reads a relative path without its leading slash as one with it', () => {
    expect([matches('/admin', 'jobs', '/admin/jobs'), matches('/admin', 'jobs', '/admin/other')]).toEqual([true, false])
  })

  // A scope's path is a route path: the middleware matches after its segments in every request the router sends to the
  // scope's routes, whatever its parameters hold, joined to the router's path.
  it.each([
    ['/service::name', '/service:name/jobs', '/service:name/other'],
    ['/release(v1)', '/release(v1)/jobs', '/release(v1)/other'],
    // A trailing slash never makes another route, so the middleware covers both forms.
    ['/admin', '/admin/jobs/', '/admin/other/'],
  ])('matches a path under %s after its segments', (base, served, unserved) => {
    expect([matches(base, '/jobs', served), matches(base, '/jobs', unserved)]).toEqual([true, false])
  })

  it.each([
    '/at/:hour(^\\d{2})h:minute(^\\d{2})m',
    '/teams/:$team([a-z]+)',
    '/d/:p((a|b)/c)',
    '/tenants/:id',
    '/v:major(\\d*)',
    '/' + Array.from({ length: 9 }, (_, i) => `:p${i}`).join('/'),
  ])('refuses a middleware path under %s, whose path holds a parameter', base => {
    expect(() => placeMiddlewares(base, [middleware('/jobs')])).toThrow(ErrConfiguration)
  })

  // A middleware at "/" covers the scope's routes, the scope's own path among them; one at a sub-path does not reach
  // it.
  it("covers the scope's own path with a middleware at its root", () => {
    expect([
      matches('/admin', '/', '/admin'),
      matches('/admin', '/', '/admin/'),
      matches('/admin', '/jobs', '/admin'),
    ]).toEqual([true, true, false])
  })

  // A router at the root spans no segment: its middleware paths match the whole request path, still on whole segments.
  it('matches a path-scoped middleware of a root router against the whole path', () => {
    expect([
      matches('', '/admin', '/admin/users'),
      matches('', '/admin', '/admin'),
      matches('', '/admin', '/adminx'),
    ]).toEqual([true, true, false])
  })
})
