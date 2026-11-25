import { describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../error/common.js'
import { ErrHTTPBadRequest } from '../error/http.js'
import { compilePrefix, normalizePath, pathAfter, placeMiddlewares, type PathFlags } from './path.js'
import type { ResolvedMiddleware } from './pipeline.js'

const noop = (): void => undefined

describe('compilePrefix', () => {
  // `/admin` guards `/admin/...` and must not leak onto a sibling that merely starts with the same letters.
  it('matches on a segment boundary', () => {
    const prefix = compilePrefix('/admin')

    expect(prefix.test('/admin/users')).toBe(true)
    expect(prefix.test('/admin')).toBe(true)
    expect(prefix.test('/adminx')).toBe(false)
  })
})

describe('normalizePath', () => {
  // The router ignores the duplicate slash: a guard that did not would be skipped by `//admin`.
  it('drops a duplicate slash when the router does', () => {
    expect(normalizePath('//admin//users', { ignoreDuplicateSlashes: true }).path).toBe('/admin/users')
    expect(normalizePath('//admin', {}).path).toBe('//admin')
  })

  it('fails a malformed escape with a 400', () => {
    const { error } = normalizePath('/%E0%A4%A', {})

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
  const matches = (base: string, flags: PathFlags, path: string, url: string): boolean => {
    const [placed] = placeMiddlewares(base, [middleware(path)], flags)
    return compilePrefix(placed!.path!).test(pathAfter(normalizePath(url, flags).path, placed!.skip ?? 0))
  }

  it('leaves a pathless middleware covering the whole scope', () => {
    const [all] = placeMiddlewares('/admin', [middleware(undefined)], {})

    expect([all!.path, all!.skip]).toEqual([undefined, undefined])
  })

  it('reads a relative path without its leading slash as one with it', () => {
    expect([matches('/admin', {}, 'jobs', '/admin/jobs'), matches('/admin', {}, 'jobs', '/admin/other')]).toEqual([
      true,
      false,
    ])
  })

  // A scope's path is a route path: the middleware matches after its segments in every request the router sends to the
  // scope's routes, whatever its parameters hold, as the request reaches it after normalizePath.
  it.each([
    ['/service::name', {}, '/service:name/jobs', '/service:name/other'],
    ['/release(v1)', {}, '/release(v1)/jobs', '/release(v1)/other'],
    ['/at/:hour(^\\d{2})h:minute(^\\d{2})m', {}, '/at/12h30m/jobs', '/at/12h30m/other'],
    ['/teams/:$team([a-z]+)', {}, '/teams/abc/jobs', '/teams/abc/other'],
    // A "/" a parameter's regex allows reaches it encoded: the router never splits a value.
    ['/d/:p((a|b)/c)', {}, '/d/a%2Fc/jobs', '/d/a%2Fc/other'],
    // The router matches a parameter with an empty value.
    ['/tenants/:id', {}, '/tenants//jobs', '/tenants//other'],
    ['/v:major(\\d*)', {}, '/v/jobs', '/v/other'],
    [
      '/' + Array.from({ length: 9 }, (_, i) => `:p${i}`).join('/'),
      {},
      '/1/2/3/4/5/6/7/8/9/jobs',
      '/1/2/3/4/5/6/7/8/9/x',
    ],
    // A trailing empty segment stays one, unless the router folds it into the path that follows.
    ['/v2/', {}, '/v2//jobs', '/v2/jobs'],
    ['/v2/', { ignoreDuplicateSlashes: true }, '/v2//jobs', '/v2/other'],
    ['/a//b', { ignoreDuplicateSlashes: true }, '/a//b/jobs', '/a/b/other'],
  ])('matches a path under %s %j after its segments', (base, flags, served, unserved) => {
    expect([matches(base, flags, '/jobs', served), matches(base, flags, '/jobs', unserved)]).toEqual([true, false])
  })

  // Neither spans a fixed number of segments: the path after them has no start.
  it.each(['/files/*', '/items/:id?'])('refuses a path under %s', base => {
    expect(() => placeMiddlewares(base, [middleware('/x')], {})).toThrow(ErrConfiguration)
  })
})
