import { describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../error/common.js'
import type { MiddlewarePath } from './middleware.js'
import { MiddlewarePipeline } from './pipeline.js'

const noop = (): void => undefined

/** The first line of what adding a middleware at `path` throws. */
function refusal(path: MiddlewarePath): string {
  try {
    new MiddlewarePipeline().add(path, noop)
  } catch (err) {
    expect(err).toBeInstanceOf(ErrConfiguration)
    return (err as Error).message.split('\n')[0]!
  }

  throw new Error('expected a throw')
}

describe('MiddlewarePipeline', () => {
  // A middleware path is a literal prefix: route syntax in it could never match, and the middleware would be skipped
  // without a word, a guard included.
  it.each(['*', '/a/:x', '/a/*', '/a(b)'])('refuses %j, which is not a literal prefix', path => {
    expect(refusal(path)).toBe(`Cannot add middleware at "${path}": a middleware path is a literal prefix`)
  })

  // A request path never holds "?" or "#" once its query and fragment are off: such a prefix could never match.
  it.each(['/a?b', '/a#b'])('refuses %j, which holds a query or a fragment', path => {
    expect(refusal(path)).toBe(`Cannot add middleware at "${path}": a request path holds no "?" or "#"`)
  })

  // An empty list covers no request: refused rather than a middleware that never runs.
  it('refuses an empty list of paths', () => {
    expect(refusal([])).toBe('Cannot add middleware at []: the list of paths is empty')
  })

  it('refuses a path holding an empty segment', () => {
    expect(refusal('/a//b')).toBe('Cannot use the path "/a//b": it holds an empty segment, "//"')
  })

  // The paths are checked at the call: a list the caller empties afterwards must not slip past that check.
  it('keeps the paths it checked when the caller changes its list afterwards', () => {
    const paths = ['/a']
    const pipeline = new MiddlewarePipeline().add(paths, noop)
    paths.length = 0

    expect(pipeline.resolve({} as never).map(middleware => middleware.path)).toEqual([['/a']])
  })
})
