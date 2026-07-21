import { describe, expect } from 'vitest'
import { it, fc } from '@fast-check/vitest'
import {
  assertSecureEndpoint,
  defaultSecureCookie,
  isSafeReturnPath,
  resolveOidcOptions,
} from './options.js'
import type { OidcAuthenticationOptions } from './options.js'

const BASE = 'https://app.example.com'

/**
 * Path-shaped strings drawn from the characters that actually decide the outcome —
 * separators, control characters the URL parser strips, and ordinary path bytes.
 *
 * An unconstrained `fc.string()` is useless here: almost nothing it generates starts with
 * `/`, so the precondition rejects it and the interesting region is never reached.
 */
const pathish = fc.array(
  fc.constantFrom('/', '\\', '\t', '\n', '\r', ' ', '.', ':', '?', '#', '%', '@', 'a', 'e', 'v', 'i', 'l', '1'),
  { maxLength: 12 },
).map(cs => `/${cs.join('')}`)

describe('isSafeReturnPath (property)', () => {
  // The guard is syntactic; the URL parser is the real authority on where a path resolves.
  // Keeping the oracle independent of the implementation is the point — it stays a genuine
  // check if the guard is ever rewritten.
  it.prop([pathish])('a path accepted as safe never resolves off-origin', s => {
    fc.pre(isSafeReturnPath(s))
    expect(new URL(s, BASE).origin).toBe(BASE)
  })

  it.prop([fc.string()])('anything not starting with a slash is rejected', s => {
    fc.pre(!s.startsWith('/'))
    expect(isSafeReturnPath(s)).toBe(false)
  })

  it.prop([fc.string()])('a protocol-relative path is always rejected', s => {
    expect(isSafeReturnPath(`//${s}`)).toBe(false)
  })

  it.prop([fc.string()])('a backslash-escaped protocol-relative path is always rejected', s => {
    expect(isSafeReturnPath(`/\\${s}`)).toBe(false)
  })
})

describe('assertSecureEndpoint (property)', () => {
  const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']

  it.prop([fc.webUrl({ validSchemes: ['https'] })])('accepts any https URL', url => {
    expect(() => assertSecureEndpoint('endpoint', url)).not.toThrow()
  })

  it.prop([fc.webUrl({ validSchemes: ['http'] })])(
    'rejects http unless the host is loopback',
    url => {
      const host = new URL(url).hostname
      fc.pre(!LOOPBACK.includes(host))
      expect(() => assertSecureEndpoint('endpoint', url)).toThrow('must use https')
    },
  )

  it.prop([fc.constantFrom(...LOOPBACK), fc.integer({ min: 1, max: 65535 })])(
    'accepts http on loopback for local development',
    (host, port) => {
      expect(() => assertSecureEndpoint('endpoint', `http://${host}:${port}/x`)).not.toThrow()
    },
  )

  it.prop([fc.webUrl()])('never throws without naming the offending label', url => {
    try {
      assertSecureEndpoint('tokenEndpoint', url)
    } catch (e) {
      expect((e as Error).message).toContain('tokenEndpoint')
    }
  })
})

describe('defaultSecureCookie (property)', () => {
  it.prop([fc.webUrl({ validSchemes: ['https'] })])('is true for any https callback', url => {
    expect(defaultSecureCookie(url)).toBe(true)
  })

  it.prop([fc.webUrl({ validSchemes: ['http'] })])('is false for any http callback', url => {
    expect(defaultSecureCookie(url)).toBe(false)
  })

  it.prop([fc.string()])('fails closed on anything unparseable', s => {
    fc.pre(!URL.canParse(s))
    expect(defaultSecureCookie(s)).toBe(true)
  })
})

/** Minimal valid input; the resolver rejects anything less. */
const optionsArb = fc.record({
  clientId: fc.string({ minLength: 1 }),
  clientSecret: fc.string({ minLength: 1 }),
  sessionSecret: fc.string({ minLength: 32, maxLength: 64 }),
  callbackUrl: fc.constantFrom(
    'https://app.example.com/auth/callback',
    'http://localhost:3000/auth/callback',
  ),
  discoveryUrl: fc.constant('https://accounts.example.com'),
  scopes: fc.option(fc.array(fc.string({ minLength: 1 }).filter(s => !s.includes(' ')), { maxLength: 5 }), {
    nil: undefined,
  }),
}) as fc.Arbitrary<OidcAuthenticationOptions>

describe('resolveOidcOptions (property)', () => {
  // Load-bearing: addOidc calls build() (which resolves) and hands the result to the
  // handler constructor (which resolves again), so every application double-resolves.
  it.prop([optionsArb])('is idempotent', input => {
    const once = resolveOidcOptions(input)
    const twice = resolveOidcOptions(once)
    expect(twice).toEqual(once)
  })

  it.prop([optionsArb])('always yields exactly one openid scope', input => {
    const { scopes } = resolveOidcOptions(input)
    expect(scopes.filter(s => s === 'openid')).toHaveLength(1)
  })

  it.prop([optionsArb])('preserves every scope the caller supplied', input => {
    const resolved = resolveOidcOptions(input)
    for (const scope of input.scopes ?? []) {
      expect(resolved.scopes).toContain(scope)
    }
  })

  it.prop([optionsArb])('prefixes cookie names with __Host- exactly when secure', input => {
    const { secureCookie, sessionCookieName, stateCookieName } = resolveOidcOptions(input)
    expect(sessionCookieName.startsWith('__Host-')).toBe(secureCookie)
    expect(stateCookieName.startsWith('__Host-')).toBe(secureCookie)
  })

  it.prop([optionsArb])('never returns a defaultRedirectPath it would itself reject', input => {
    expect(isSafeReturnPath(resolveOidcOptions(input).defaultRedirectPath)).toBe(true)
  })
})
