import { describe, expect, it } from 'vitest'

import { ErrHTTPBadRequest } from '../error/http.js'
import { normalizePath, pathAfter, placeMiddlewares, prefixMatcher } from './path.js'
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

describe('normalizePath', () => {
  it('fails a malformed escape with a 400', () => {
    const { error } = normalizePath('/%E0%A4%A')

    expect(error).toBeInstanceOf(ErrHTTPBadRequest)
  })
})

describe('placeMiddlewares', () => {
  const middleware = (path: string | undefined): ResolvedMiddleware => ({
    path,
    hook: undefined,
    handle: noop,
  })

  // What the middleware sees of a request to one of the scope's routes, as the chain matches it.
  const matches = (base: string, path: string, url: string): boolean => {
    const [placed] = placeMiddlewares(base, [middleware(path)])
    return prefixMatcher(placed!.path!)(pathAfter(normalizePath(url).path, placed!.skip ?? 0))
  }

  it('leaves a pathless middleware covering the whole scope', () => {
    const [all] = placeMiddlewares('/admin', [middleware(undefined)])

    expect([all!.path, all!.skip]).toEqual([undefined, undefined])
  })

  it('reads a relative path without its leading slash as one with it', () => {
    expect([matches('/admin', 'jobs', '/admin/jobs'), matches('/admin', 'jobs', '/admin/other')]).toEqual([true, false])
  })

  // A scope's path is a route path: the middleware matches after its segments in every request the router sends to the
  // scope's routes, whatever its parameters hold, as the request reaches it after normalizePath.
  it.each([
    ['/service::name', '/service:name/jobs', '/service:name/other'],
    ['/release(v1)', '/release(v1)/jobs', '/release(v1)/other'],
    ['/at/:hour(^\\d{2})h:minute(^\\d{2})m', '/at/12h30m/jobs', '/at/12h30m/other'],
    ['/teams/:$team([a-z]+)', '/teams/abc/jobs', '/teams/abc/other'],
    // A "/" a parameter's regex allows reaches it encoded: the router never splits a value.
    ['/d/:p((a|b)/c)', '/d/a%2Fc/jobs', '/d/a%2Fc/other'],
    // The router matches a parameter with an empty value.
    ['/tenants/:id', '/tenants//jobs', '/tenants//other'],
    ['/v:major(\\d*)', '/v/jobs', '/v/other'],
    ['/' + Array.from({ length: 9 }, (_, i) => `:p${i}`).join('/'), '/1/2/3/4/5/6/7/8/9/jobs', '/1/2/3/4/5/6/7/8/9/x'],
    // A trailing slash never makes another route, so the middleware covers both forms.
    ['/admin', '/admin/jobs/', '/admin/other/'],
  ])('matches a path under %s after its segments', (base, served, unserved) => {
    expect([matches(base, '/jobs', served), matches(base, '/jobs', unserved)]).toEqual([true, false])
  })
})
