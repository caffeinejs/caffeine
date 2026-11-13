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
      trustProxy: undefined,
      requestIDHeader: undefined,
      application: 'fetch application',
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

  it('trusts any peer under trustProxy: true', () => {
    expect(resolveServerSettings({ trustProxy: true }).trustProxy?.(undefined)).toBe(true)
  })

  // The fetch runtime gives no peer address, so a list could never match.
  it('refuses a trustProxy list on the fetch application', () => {
    expect(() => resolveServerSettings({ trustProxy: 'loopback' })).toThrow(
      'Cannot set trustProxy to a list of addresses on the fetch application',
    )
  })

  it('refuses a trustProxy hop count', () => {
    expect(() => resolveServerSettings({ trustProxy: 1 })).toThrow('a hop count cannot tell a proxy from a client')
  })

  // The fetch application cannot name proxies by address, so the refusal offers true or the Node application instead.
  it('refuses a hop count on the fetch application, offering true or the Node application', () => {
    let message = ''
    try {
      resolveServerSettings({ trustProxy: 1 })
    } catch (err) {
      message = (err as Error).message
    }

    expect(message).toContain('Write trustProxy: true when only trusted proxies can reach the application')
    expect(message.includes("Name the proxy's addresses")).toBe(false)
  })

  // A list is refused there, so the refusal of any other value offers only what the fetch application takes.
  it('refuses a trustProxy of another type on the fetch application, offering only a boolean', () => {
    let message = ''
    try {
      resolveServerSettings({ trustProxy: {} })
    } catch (err) {
      message = (err as Error).message
    }

    expect(message.split('\n')[0]).toBe('Cannot set trustProxy to "[object Object]": it must be true or false')
    expect(message).toContain('Write trustProxy: true when only trusted proxies can reach the application')
    expect(message.includes('a list such as')).toBe(false)
  })

  it('reads requestIDHeader lower-cased', () => {
    expect(resolveServerSettings({ requestIDHeader: 'X-Request-ID' }).requestIDHeader).toBe('x-request-id')
  })

  it.each(['', 'x y', 5])('refuses a requestIDHeader of %j', value => {
    expect(() => resolveServerSettings({ requestIDHeader: value })).toThrow(
      `Cannot set requestIDHeader to "${String(value)}": it is not a header name`,
    )
  })

  it('refuses listen on the fetch application and names the Node entry', () => {
    const resolve = () => resolveServerSettings({ listen: { port: 3000 } })

    expect(resolve).toThrow('"listen" is not a setting of the fetch application')
    expect(resolve).toThrow('"@caffeinejs/http/node"')
  })

  it('lists every setting the application takes when refusing an unknown one', () => {
    expect(() => resolveServerSettings({ port: 3000 })).toThrow(
      'Return only handlerTimeout, router, matcher, trustProxy, requestIDHeader from ".server(...)"',
    )
  })
})
