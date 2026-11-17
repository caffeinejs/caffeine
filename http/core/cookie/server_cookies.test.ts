import { CaffeineIoC, token } from '@caffeinejs/di'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ErrCookieConfiguration, ErrCookieTooLate } from './errors.js'
import type { CookiePluginOptions } from './keys.js'
import { kCookieFlush, kPendingCookies, ServerCookies, type CookieJar } from './server_cookies.js'
import { CookieSigner, HMACCookieSigner, type CookieUnsignResult } from './signer.js'

const S = 's'.repeat(32)

let container: CaffeineIoC
let lines: string[]

beforeAll(async () => {
  container = new CaffeineIoC()
  await container.init()
})

beforeEach(() => {
  lines = []
})

// The jar is the caller's own object, and its two fields are what the engine's context reads.
function jar(): CookieJar {
  return { [kPendingCookies]: null, [kCookieFlush]: 'open' }
}

function cookies(options: Partial<CookiePluginOptions> = {}): ServerCookies<CookieJar> {
  return ServerCookies.resolve<CookieJar>({ enabled: true, ...options }, container, (_jar, written) => {
    lines.push(...written)
  })
}

function firstLine(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    return (err as Error).message.split('\n')[0]!
  }

  throw new Error('expected a throw')
}

describe('resolve', () => {
  it.each([
    [
      'a signer and a secret',
      { signer: new HMACCookieSigner({ secret: S }), secret: S },
      'Cannot install cookies: both a signer and a secret are configured',
    ],
    [
      'a signer and an algorithm',
      { signer: new HMACCookieSigner({ secret: S }), algorithm: 'SHA-512' as const },
      'Cannot install cookies: both a signer and an algorithm are configured',
    ],
    [
      'a signer key nothing is bound to',
      { signer: token<CookieSigner>(Symbol('unbound')) },
      'Cannot install cookies: no binding registered for the given signer key',
    ],
    [
      'a signer with no sign and unsign',
      { signer: {} as never },
      'Cannot install cookies: the signer has no "sign" and "unsign" methods',
    ],
    ['a short secret', { secret: 'short' }, 'Cannot sign cookies: the secret must be at least 32 characters'],
  ])('refuses %s', (_label, options, message) => {
    expect(() => cookies(options)).toThrow(ErrCookieConfiguration)
    expect(firstLine(() => cookies(options))).toBe(message)
  })
})

describe('parse', () => {
  it('reads the cookies a header carries, decoded', () => {
    expect(cookies().parse('a=1; b=%20x')).toEqual({ a: '1', b: ' x' })
  })

  it('reads no header as no cookies', () => {
    expect(cookies().parse(undefined)).toEqual({})
  })
})

describe('queue and flush', () => {
  it('writes an unsigned cookie synchronously, once flushed', () => {
    const server = cookies()
    const j = jar()

    server.queue(j, 'set', 'a', 'b', undefined, { secure: false, late: false })
    expect(lines).toEqual([])

    expect(server.flush(j)).toBeUndefined()
    expect(lines).toEqual(['a=b; Path=/; SameSite=Lax'])
    expect(j[kCookieFlush]).toBe('done')
  })

  it('keeps the last value of a cookie set twice', () => {
    const server = cookies()
    const j = jar()

    server.queue(j, 'set', 'a', '1', undefined, { secure: false, late: false })
    server.queue(j, 'set', 'a', '2', undefined, { secure: false, late: false })
    void server.flush(j)

    expect(lines).toEqual(['a=2; Path=/; SameSite=Lax'])
  })

  it('writes a deletion as an expired, empty cookie', () => {
    const server = cookies()
    const j = jar()

    server.queue(j, 'delete', 'a', '', undefined, { secure: false, late: false })
    void server.flush(j)

    expect(lines).toEqual(['a=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax'])
  })

  it('writes an unsigned cookie at once after the flush', () => {
    const server = cookies()
    const j = jar()

    void server.flush(j)
    server.queue(j, 'set', 'c', '1', undefined, { secure: false, late: false })

    expect(lines).toEqual(['c=1; Path=/; SameSite=Lax'])
  })

  it('refuses a signed cookie after the flush: nothing would sign it', () => {
    const server = cookies({ secret: S })
    const j = jar()

    void server.flush(j)

    expect(() => server.queue(j, 'set', 's', 'v', { signed: true }, { secure: false, late: false })).toThrow(
      ErrCookieTooLate,
    )
    expect(firstLine(() => server.queue(j, 'set', 's', 'v', { signed: true }, { secure: false, late: false }))).toBe(
      'Cannot set cookie "s" signed: the response\'s cookies are already written',
    )
  })

  it('refuses any cookie once the response is out', () => {
    const server = cookies()

    expect(() => server.queue(jar(), 'set', 'a', 'b', undefined, { secure: false, late: true })).toThrow(
      ErrCookieTooLate,
    )
    expect(firstLine(() => server.queue(jar(), 'set', 'a', 'b', undefined, { secure: false, late: true }))).toBe(
      'Cannot set cookie "a": the response\'s headers are already sent',
    )
  })

  it('signs before writing, asynchronously, a value that verifies back', async () => {
    const server = cookies({ secret: S })
    const j = jar()

    server.queue(j, 'set', 's', 'v', { signed: true }, { secure: false, late: false })
    const flushed = server.flush(j)

    expect(flushed).toBeInstanceOf(Promise)
    await flushed

    expect(lines).toHaveLength(1)
    expect(lines[0]!.startsWith('s=')).toBe(true)
    const value = decodeURIComponent(lines[0]!.slice(2, lines[0]!.indexOf(';')))
    expect(await server.signed({ s: value }, 's', undefined)).toBe('v')
  })

  it('refuses a signed cookie with nothing to sign it with', () => {
    const server = cookies()

    expect(() => server.queue(jar(), 'set', 's', 'v', { signed: true }, { secure: false, late: false })).toThrow(
      ErrCookieConfiguration,
    )
    expect(
      firstLine(() => server.queue(jar(), 'set', 's', 'v', { signed: true }, { secure: false, late: false })),
    ).toBe('Cannot set cookie "s" signed: no secret is configured')
  })

  it('writes nothing when nothing was queued', () => {
    const server = cookies()
    const j = jar()

    expect(server.flush(j)).toBeUndefined()
    expect(lines).toEqual([])
    expect(j[kCookieFlush]).toBe('done')
  })

  it('drops the batch and rejects when signing fails', async () => {
    const boom = new Error('boom')

    class Failing extends CookieSigner {
      sign(): Promise<string> {
        return Promise.reject(boom)
      }

      unsign(): Promise<CookieUnsignResult> {
        return Promise.resolve({ valid: false, renew: false, value: null })
      }
    }

    const server = cookies({ signer: new Failing() })
    const j = jar()

    server.queue(j, 'set', 's', 'v', { signed: true }, { secure: false, late: false })

    await expect(server.flush(j)).rejects.toBe(boom)
    expect(j[kCookieFlush]).toBe('failed')

    j[kCookieFlush] = 'open'
    expect(server.flush(j)).toBeUndefined()
    expect(lines).toEqual([])
  })
})

describe('signed', () => {
  it('verifies every cookie, answering false for one that does not verify', async () => {
    const server = cookies({ secret: S })
    const value = await new HMACCookieSigner({ secret: S }).sign('v')

    expect(await server.signed({ s: value, t: 'x' }, undefined, undefined)).toEqual({ s: 'v', t: false })
  })

  it('answers undefined for a cookie the request does not carry', async () => {
    expect(await cookies({ secret: S }).signed({}, 's', undefined)).toBeUndefined()
  })
})
