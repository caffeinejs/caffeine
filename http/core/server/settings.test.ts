import { Day } from '@caffeinejs/std/duration'
import { describe, expect, it } from 'vitest'

import { ErrConfiguration } from '../error/common.js'
import { findMyWayMatcher } from '../matcher/find_my_way.js'
import { DEFAULT_ROUTER_FLAGS } from '../matcher/matcher.js'
import { resolveServerSettings } from './settings.js'

describe('resolveServerSettings', () => {
  it("defaults to find-my-way's flags, the default matcher and no timeout", () => {
    expect(resolveServerSettings({})).toEqual({
      handlerTimeout: undefined,
      router: DEFAULT_ROUTER_FLAGS,
      matcher: findMyWayMatcher,
    })
  })

  it('merges given router flags over the defaults', () => {
    expect(resolveServerSettings({ router: { caseSensitive: false } }).router).toEqual({
      ...DEFAULT_ROUTER_FLAGS,
      caseSensitive: false,
    })
  })

  // A Fastify section on the fetch application would otherwise be dropped without a word.
  it('refuses factory and names the Fastify entry', () => {
    const resolve = () => resolveServerSettings({ factory: { bodyLimit: 1 } })

    expect(resolve).toThrow(ErrConfiguration)
    expect(resolve).toThrow('"factory"')
    expect(resolve).toThrow('@caffeinejs/http/fastify')
  })

  // No magic value: 0 does not mean "no limit", and a limit that cannot elapse is not one.
  // 30 days is past what a timer can wait: it would fire at once.
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '30s', 30 * Day])('refuses a handlerTimeout of %s', value => {
    expect(() => resolveServerSettings({ handlerTimeout: value })).toThrow(
      `Cannot set handlerTimeout to "${String(value)}"`,
    )
  })

  it('refuses a router that is not an object', () => {
    expect(() => resolveServerSettings({ router: true })).toThrow('Cannot set router to "true"')
  })

  it('refuses a router flag that is not a boolean', () => {
    expect(() => resolveServerSettings({ router: { caseSensitive: 'false' } })).toThrow(
      'Cannot set router.caseSensitive to "false": a router flag is true or false',
    )
  })

  it('refuses an unknown router flag', () => {
    expect(() => resolveServerSettings({ router: { caseInsensitive: true } })).toThrow(
      'Cannot set router "caseInsensitive": it is not a router flag',
    )
  })

  it('refuses a matcher that is not a function', () => {
    expect(() => resolveServerSettings({ matcher: 'find-my-way' })).toThrow(
      'Cannot use the matcher setting: it must be a function, got string',
    )
  })
})
