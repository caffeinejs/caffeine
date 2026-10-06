import { describe, expect, it } from 'vitest'

import { cookieDefaults, parseCookies, prepareCookie, serializeCookie, type CookieOperation } from './_serialize.js'
import { ErrInvalidCookie } from './errors.js'
import type { CookieParseOptions, CookieSerializeOptions } from './options.js'

/** The `Set-Cookie` line a server with `parseOptions` writes for a call, over plain HTTP unless `https`. */
function line(
  op: CookieOperation,
  name: string,
  value: string,
  options?: CookieSerializeOptions,
  parseOptions?: CookieParseOptions,
  https = false,
): string {
  const { defaults } = cookieDefaults(parseOptions)
  return serializeCookie(op, prepareCookie(op, name, defaults, options, https), value)
}

describe('the attributes a cookie goes out with', () => {
  // What nobody wrote down: the whole application, and Lax, as `@fastify/cookie` defaulted.
  it('defaults to Path=/ and SameSite=Lax', () => {
    expect(line('set', 'theme', 'dark')).toBe('theme=dark; Path=/; SameSite=Lax')
  })

  it("takes the server's defaults under the call's own", () => {
    const parseOptions: CookieParseOptions = { path: '/app', httpOnly: true, sameSite: 'strict' }

    expect(line('set', 'theme', 'dark', undefined, parseOptions)).toBe(
      'theme=dark; Path=/app; HttpOnly; SameSite=Strict',
    )
    expect(line('set', 'theme', 'dark', { path: '/other' }, parseOptions)).toBe(
      'theme=dark; Path=/other; HttpOnly; SameSite=Strict',
    )
  })

  // How a call opts out of a default: the way `Object.assign` let it with `@fastify/cookie`.
  it('clears a default the call writes as undefined, and leaves SameSite off for false', () => {
    expect(line('set', 'theme', 'dark', { path: undefined, sameSite: false })).toBe('theme=dark')
  })

  describe("with secure: 'auto'", () => {
    it('is Secure over HTTPS', () => {
      expect(line('set', 'id', 'v', { secure: 'auto' }, undefined, true)).toBe('id=v; Path=/; Secure; SameSite=Lax')
    })

    it('is not over plain HTTP', () => {
      expect(line('set', 'id', 'v', { secure: 'auto' })).toBe('id=v; Path=/; SameSite=Lax')
    })

    // A browser drops SameSite=None without Secure, so the cookie falls back to what it could keep.
    it('sends SameSite=None as Lax over plain HTTP', () => {
      expect(line('set', 'id', 'v', { secure: 'auto', sameSite: 'none' })).toBe('id=v; Path=/; SameSite=Lax')
      expect(line('set', 'id', 'v', { secure: 'auto', sameSite: 'none' }, undefined, true)).toBe(
        'id=v; Path=/; Secure; SameSite=None',
      )
    })
  })

  describe('expires', () => {
    it('takes milliseconds since the epoch', () => {
      expect(line('set', 'id', 'v', { expires: Date.UTC(2030, 0, 1) })).toBe(
        'id=v; Path=/; Expires=Tue, 01 Jan 2030 00:00:00 GMT; SameSite=Lax',
      )
    })

    it('takes 0 as the epoch', () => {
      expect(line('set', 'id', 'v', { expires: 0 })).toContain('Expires=Thu, 01 Jan 1970 00:00:00 GMT')
    })

    it.each([Number.NaN, new Date(Number.NaN)])('refuses %s', expires => {
      expect(() => line('set', 'id', 'v', { expires })).toThrow(
        'Cannot set cookie "id": its expiry is not a valid date',
      )
    })
  })

  // What the cookie schemes clear their cookies with, and what tests across the repository read back.
  it('clears a cookie with an empty value, Max-Age=0 and the epoch', () => {
    expect(line('delete', 'n', 'ignored', { maxAge: 60, expires: Date.now() + 60_000, signed: true })).toBe(
      'n=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax',
    )
  })

  it('writes every attribute in the order cookie@2 does', () => {
    expect(
      line('set', 'id', 'v', {
        domain: 'example.com',
        maxAge: 60,
        httpOnly: true,
        secure: true,
        partitioned: true,
        priority: 'high',
        sameSite: 'none',
      }),
    ).toBe('id=v; Max-Age=60; Domain=example.com; Path=/; HttpOnly; Secure; Partitioned; Priority=High; SameSite=None')
  })
})

describe('what a cookie is refused for', () => {
  // Refused where it was written, deletion included: a deletion a browser ignores leaves the cookie in place.
  it.each(['set', 'delete'] as const)('a broken prefix rule, on %s', op => {
    expect(() => prepareCookie(op, '__Host-id', { path: '/' }, undefined, false)).toThrow(
      new ErrInvalidCookie(`Cannot ${op} cookie "__Host-id": a "__Host-" cookie needs Secure, Path=/ and no Domain`),
    )
  })

  it('SameSite=None and Partitioned without Secure', () => {
    expect(() => line('set', 'id', 'v', { sameSite: 'none' })).toThrow('SameSite=None needs Secure')
    expect(() => line('set', 'id', 'v', { partitioned: true })).toThrow('Partitioned needs Secure')
  })

  // RFC 6265bis §5.6: a user agent drops a cookie whose name and value come to more than 4096 octets.
  it('a name and value past 4096 bytes', () => {
    const name = 'id'
    const fits = 'v'.repeat(4096 - name.length)

    expect(line('set', name, fits)).toBe(`${name}=${fits}; Path=/; SameSite=Lax`)
    expect(() => line('set', name, `${fits}v`)).toThrow(
      'Cannot set cookie "id": its name and value come to 4097 bytes, past the 4096 a browser keeps',
    )
  })

  it('a Max-Age that is not whole seconds', () => {
    expect(() => line('set', 'id', 'v', { maxAge: 1.5 })).toThrow('its Max-Age is not a whole number of seconds')
  })

  // cookie@2 repeats a value it refuses in its message, and a message — or a cause — can reach a client.
  it('a value it cannot carry, without repeating it', () => {
    const secretish = 'card=4111 1111'
    let thrown: unknown

    try {
      line('set', 'id', secretish, { encode: value => value })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(ErrInvalidCookie)
    expect((thrown as Error).message).toBe(
      'Cannot set cookie "id": its value, once encoded, holds characters a cookie cannot carry',
    )
    expect((thrown as Error).message).not.toContain('4111')
    expect((thrown as Error).cause).toBeUndefined()
  })

  it('a name it cannot carry, without repeating it', () => {
    expect(() => line('set', 'a\nb', 'v')).toThrow(/^Cannot set a cookie with an invalid name: its name may hold/)
  })

  // No URL encoding carries a lone surrogate; what `encodeURIComponent` throws for one, a URIError, stays inside.
  it('a value holding a lone surrogate', () => {
    let thrown: unknown

    try {
      line('set', 'id', 'a\uD800b')
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(ErrInvalidCookie)
    expect((thrown as Error).message).toBe(
      'Cannot set cookie "id": its value holds a character that cannot be URL-encoded',
    )
    expect((thrown as Error).cause).toBeUndefined()
  })
})

// JavaScript can hand a flag any value, and cookie@2 writes the flag for any truthy one: the rules judge what it writes.
describe('a flag given as a truthy non-boolean', () => {
  it('is refused as the flag it writes', () => {
    expect(() => line('set', 'id', 'v', { partitioned: 1 as unknown as boolean })).toThrow('Partitioned needs Secure')
  })

  it('meets what a prefix needs as the flag it writes', () => {
    expect(line('set', '__Host-id', 'v', { secure: 1 as unknown as boolean })).toBe(
      '__Host-id=v; Path=/; Secure; SameSite=Lax',
    )
  })
})

describe('what an encoder throws', () => {
  // A TypeError reads like one of cookie@2's, and its message may repeat the value just as theirs do.
  it('is refused without its message, when it is a TypeError', () => {
    let thrown: unknown

    try {
      line('set', 'id', 'card=4111', {
        encode: value => {
          throw new TypeError(`cannot encode ${value}`)
        },
      })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(ErrInvalidCookie)
    expect((thrown as Error).message).toBe('Cannot set cookie "id": it cannot be written as a Set-Cookie header')
    expect((thrown as Error).cause).toBeUndefined()
  })

  // The encoder is the application's, and so is any other error it throws: it reaches the caller as it was thrown.
  it('passes through, when it is not a TypeError', () => {
    const failure = new RangeError('the encoder gave up')
    let thrown: unknown

    try {
      line('set', 'id', 'v', {
        encode: () => {
          throw failure
        },
      })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBe(failure)
  })
})

describe('which cookies replace one another in a response', () => {
  const key = (name: string, options?: CookieSerializeOptions) =>
    prepareCookie('set', name, { path: '/' }, { secure: true, ...options }, true).key

  it('is one cookie for one name, domain and path, as a browser sees it', () => {
    expect(key('id', { domain: 'Example.com' })).toBe(key('id', { domain: '.example.com' }))
    expect(key('id')).not.toBe(key('id', { path: '/app' }))
    expect(key('id')).not.toBe(key('ID'))
  })

  // CHIPS: a partitioned cookie and an unpartitioned one of the same name are two cookies to a browser.
  it('tells a partitioned cookie apart', () => {
    expect(key('id')).not.toBe(key('id', { partitioned: true }))
  })
})

describe('parseCookies', () => {
  it('lets the first of two cookies sharing a name win, as a browser sends the more specific first', () => {
    expect(parseCookies('a=1; a=2', undefined)).toEqual({ a: '1' })
  })

  it('decodes with the decoder given', () => {
    expect(parseCookies('a=x', value => value.toUpperCase())).toEqual({ a: 'X' })
  })

  // A cookie planted from a sibling domain comes after the one the application set: it must not take the place of a
  // first value the decoder cannot read.
  it('leaves out a cookie the decoder answers undefined for, and not for the next of its name', () => {
    const decode = (value: string) => (value === 'unreadable' ? undefined : value)

    expect(parseCookies('a=unreadable; a=planted; b=1', decode)).toEqual({ b: '1' })
  })

  // Cookie names are the client's to choose.
  it.each([
    ['without a decoder', undefined],
    ['with one', (value: string) => value],
  ])('reaches no prototype through a name, %s', (_what, decode) => {
    const cookies = parseCookies('__proto__=x; constructor=y; toString=z', decode)

    expect(cookies.__proto__).toBe('x')
    expect(cookies.constructor).toBe('y')
    expect(({} as Record<string, unknown>).x).toBeUndefined()
  })
})
