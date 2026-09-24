import { describe, expect, it } from 'vitest'

import { normalizeBasePath, resolveAppURL, stripBasePath } from './base_path.js'
import { ErrConfiguration } from './error/common.js'

/**
 * What the server takes off a request's path before routing it, and what it refuses to take.
 *
 * Every row is a way a request can arrive through a gateway. A base stripped where it should not be sends a
 * request to a route it never asked for; one left on where it should come off makes the application unreachable
 * through the gateway.
 */
describe('stripBasePath', () => {
  it.each([
    // [url, base, expected, why]
    ['/api/pets', '/api', '/pets', 'the plain case'],
    ['/api', '/api', '/', 'the base alone is the root'],
    ['/api/', '/api', '/', 'the base alone, with its trailing slash'],
    ['/api?x=1', '/api', '/?x=1', 'a query straight after the base still gets a path'],
    ['/api/pets?x=1&next=/api/y', '/api', '/pets?x=1&next=/api/y', 'the query is never touched'],
    ['/api/api/pets', '/api', '/api/pets', 'taken off exactly once'],
    ['/v1/api/pets', '/v1/api', '/pets', 'a base of several segments'],
  ])('takes %s under %s to %s: %s', (url, base, expected) => {
    expect(stripBasePath(url, base)).toBe(expected)
  })

  it.each([
    ['/apix/pets', '/api', 'the base must end on a segment boundary'],
    ['/API/pets', '/api', 'the comparison is case-sensitive, as the router is'],
    ['/api%2Fpets', '/api', 'an encoded slash is not a segment boundary'],
    ['//api/pets', '/api', 'nothing is normalized ahead of the base'],
    ['/api#x', '/api', 'only "/" and "?" end a base'],
    ['/ap', '/api', 'a URL shorter than the base'],
    ['/', '/api', 'the root, without the base'],
    ['/pets', '/api', 'a URL that never carried the base'],
    ['/v1/pets', '/v1/api', 'part of a base of several segments is not the base'],
  ])('leaves %s alone under %s: %s', (url, base) => {
    expect(stripBasePath(url, base)).toBeUndefined()
  })
})

describe('normalizeBasePath', () => {
  it.each([
    ['/api', '/api'],
    ['/api/', '/api'],
    ['/api//', '/api'],
    ['/v1/api/', '/v1/api'],
  ])('reads %s as %s', (value, expected) => {
    expect(normalizeBasePath(value)).toBe(expected)
  })

  it.each([[undefined], [''], ['/'], ['//']])('reads %s as no base path at all', value => {
    expect(normalizeBasePath(value)).toBeUndefined()
  })

  it('refuses a base path that does not start with "/", naming it and the fix', () => {
    const err = captureError(() => normalizeBasePath('api/'))

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect(err).toMatchObject({ code: 'ERR_CONFIGURATION' })
    expect(err.message).toContain('"api/" does not start with "/"')
    expect(err.message).toContain('Write it as "/api"')
  })

  it.each([
    ['/api?x', '?'],
    ['/api#x', '#'],
  ])('refuses %s, which no request path could ever start with', (value, char) => {
    const err = captureError(() => normalizeBasePath(value))

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect(err.message).toContain(`"${value}" contains "${char}"`)
  })

  // The base goes in front of every redirect the framework builds, so it must never be one a browser reads as naming
  // another host: `~/done` under `//evil.example` is `//evil.example/done`.
  it.each([
    ['//evil.example', '//'],
    ['/\\evil.example', '/\\'],
  ])('refuses %s, which a browser reads as another host, naming the fix', (value, start) => {
    const err = captureError(() => normalizeBasePath(value))

    expect(err).toBeInstanceOf(ErrConfiguration)
    expect(err.message).toContain(`"${value}" starts with "${start}"`)
    expect(err.message).toContain('Start it with a single "/"')
  })

  // A browser drops tabs and line breaks before it reads a URL: `/\t/evil.example` is `//evil.example` to it.
  it.each([['/\t/evil.example'], ['/\n/evil.example'], ['/api\r'], ['/api\x00']])(
    'refuses %j, which holds a control character',
    value => {
      const err = captureError(() => normalizeBasePath(value))

      expect(err).toBeInstanceOf(ErrConfiguration)
      expect(err.message).toContain(`${JSON.stringify(value)} contains a control character`)
    },
  )
})

/**
 * What `~/` resolves to. It is how an application writes a URL relative to itself for the browser, so it must land
 * under the base, and nothing else may change — least of all into a URL that leaves the origin.
 */
describe('resolveAppURL', () => {
  it.each([
    // [url, base, expected, why]
    ['~/done', '/api', '/api/done', 'under the base'],
    ['~/done', '', '/done', 'at the root when there is no base'],
    ['~/', '/api', '/api/', 'the application root'],
    ['~/', '', '/', 'the root itself'],
    ['~/a/b?x=1#f', '/api', '/api/a/b?x=1#f', 'the query and the fragment go along'],
  ])('resolves %s under "%s" to %s: %s', (url, base, expected) => {
    expect(resolveAppURL(url, base)).toBe(expected)
  })

  it.each([
    ['/done', 'a path is sent as written: the base is only added when asked for'],
    ['https://example.com/x', 'an absolute URL'],
    ['./~/x', 'a relative URL that merely contains "~/"'],
    ['~done', '"~" without the slash'],
    ['~', 'a lone "~"'],
    ['', 'an empty URL'],
  ])('leaves %s as it is: %s', url => {
    expect(resolveAppURL(url, '/api')).toBe(url)
  })

  // Each would begin with `//` once a browser has read it, and leave the origin.
  it.each([
    ['~//evil.example'],
    ['~/\\evil.example'],
    ['~/\t/evil.example'],
    ['~/\n/evil.example'],
    ['~/\r/evil.example'],
  ])('leaves %j as it is rather than resolving it off the origin', url => {
    expect(resolveAppURL(url, '')).toBe(url)
    expect(resolveAppURL(url, '/api')).toBe(url)
  })
})

function captureError(fn: () => unknown): Error {
  try {
    fn()
  } catch (e) {
    return e as Error
  }

  throw new Error('expected the call to throw')
}
