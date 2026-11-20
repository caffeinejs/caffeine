import { describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../error/common.js'
import { ErrHTTPBadRequest } from '../error/http.js'
import { compilePrefix, normalizePath, rebaseMiddlewares } from './path.js'
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

describe('rebaseMiddlewares', () => {
  const middleware = (path: string | undefined): ResolvedMiddleware => ({
    path,
    hook: undefined,
    handle: noop,
  })

  it('starts a relative path from the scope and leaves a pathless one alone', () => {
    const [jobs, all] = rebaseMiddlewares('/admin', [middleware('jobs'), middleware(undefined)])

    expect(jobs.path).toBe('/admin/jobs')
    expect(all.path).toBe(undefined)
  })

  // A wildcard has no prefix form: a rebased path under one could never match what the router serves.
  it('refuses a path under a wildcard', () => {
    expect(() => rebaseMiddlewares('/files/*', [middleware('/x')])).toThrow(ErrConfiguration)
  })
})
