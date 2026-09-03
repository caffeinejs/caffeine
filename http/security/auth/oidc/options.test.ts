import { describe, it, expect } from 'vitest'

import { OIDCAuthenticationOptionsBuilder } from './options.js'

/** Cookie defaults are namespaced by strategy, so build() needs the scheme. */
const SCHEME = 'OIDC'

function minimal() {
  return new OIDCAuthenticationOptionsBuilder()
    .clientID('cid')
    .clientSecret('csecret')
    .sessionSecret('session-secret-at-least-32-chars!!')
    .callbackURL('https://app.example.com/auth/callback')
    .discoveryURL('https://accounts.example.com')
    .issuer('https://accounts.example.com')
}

describe('OIDCAuthenticationOptionsBuilder.build(SCHEME)', () => {
  it('throws without clientID', () => {
    expect(() =>
      new OIDCAuthenticationOptionsBuilder()
        .clientSecret('s')
        .sessionSecret('s'.repeat(32))
        .callbackURL('https://x.com/cb')
        .discoveryURL('https://x.com')
        .issuer('https://x.com')
        .build(SCHEME),
    ).toThrow('clientID is required')
  })

  it('throws without clientSecret', () => {
    expect(() =>
      new OIDCAuthenticationOptionsBuilder()
        .clientID('id')
        .sessionSecret('s'.repeat(32))
        .callbackURL('https://x.com/cb')
        .discoveryURL('https://x.com')
        .issuer('https://x.com')
        .build(SCHEME),
    ).toThrow('clientSecret is required')
  })

  it('throws without sessionSecret', () => {
    expect(() =>
      new OIDCAuthenticationOptionsBuilder()
        .clientID('id')
        .clientSecret('s')
        .callbackURL('https://x.com/cb')
        .discoveryURL('https://x.com')
        .issuer('https://x.com')
        .build(SCHEME),
    ).toThrow('sessionSecret is required')
  })

  it('throws without callbackURL', () => {
    expect(() =>
      new OIDCAuthenticationOptionsBuilder()
        .clientID('id')
        .clientSecret('s')
        .sessionSecret('s'.repeat(32))
        .discoveryURL('https://x.com')
        .issuer('https://x.com')
        .build(SCHEME),
    ).toThrow('callbackURL is required')
  })

  it('throws without discoveryURL or manual endpoints', () => {
    expect(() =>
      new OIDCAuthenticationOptionsBuilder()
        .clientID('id')
        .clientSecret('s')
        .sessionSecret('s'.repeat(32))
        .callbackURL('https://x.com/cb')
        .build(SCHEME),
    ).toThrow('provide discoveryURL or all of')
  })

  it('throws with only partial manual endpoints', () => {
    expect(() =>
      new OIDCAuthenticationOptionsBuilder()
        .clientID('id')
        .clientSecret('s')
        .sessionSecret('s'.repeat(32))
        .callbackURL('https://x.com/cb')
        .authorizationEndpoint('https://x.com/auth')
        .tokenEndpoint('https://x.com/token')
        .build(SCHEME),
    ).toThrow('provide discoveryURL or all of')
  })

  it('succeeds with discoveryURL', () => {
    const opts = minimal().build(SCHEME)
    expect(opts.clientID).toBe('cid')
    expect(opts.discoveryURL).toBe('https://accounts.example.com')
  })

  it('succeeds with full manual endpoints', () => {
    const opts = new OIDCAuthenticationOptionsBuilder()
      .clientID('cid')
      .clientSecret('s')
      .sessionSecret('s'.repeat(32))
      .callbackURL('https://app.example.com/cb')
      .authorizationEndpoint('https://x.com/auth')
      .tokenEndpoint('https://x.com/token')
      .jwksURI('https://x.com/jwks')
      .issuer('https://x.com')
      .build(SCHEME)
    expect(opts.authorizationEndpoint).toBe('https://x.com/auth')
    expect(opts.issuer).toBe('https://x.com')
  })

  it('applies defaults for optional fields', () => {
    const opts = minimal().build(SCHEME)
    // https callback -> secure -> __Host- prefixed names
    expect(opts.sessionCookieName).toBe('__Host-oidc_OIDC_session')
    expect(opts.sessionCookieTtlSeconds).toBe(3600)
    expect(opts.stateCookieName).toBe('__Host-oidc_OIDC_state')
    expect(opts.defaultRedirectPath).toBe('/')
    expect(opts.roleClaimType).toBe('roles')
    expect(opts.allowPlainPKCE).toBe(false)
    expect(opts.clockToleranceSeconds).toBe(60)
    expect(opts.httpTimeoutMs).toBe(5000)
    // Data minimisation: profile and email are opt-in, not default.
    expect(opts.scopes).toEqual(['openid'])
    // PII stays out of diagnostics unless explicitly revealed.
    expect(opts.showPii).toBe(false)
    // Secure by default: the callbackURL above is https.
    expect(opts.secureCookie).toBe(true)
  })

  describe('sessionSecret strength', () => {
    it('throws when sessionSecret is shorter than 32 characters', () => {
      expect(() =>
        new OIDCAuthenticationOptionsBuilder()
          .clientID('id')
          .clientSecret('s')
          .sessionSecret('s'.repeat(31))
          .callbackURL('https://x.com/cb')
          .discoveryURL('https://x.com')
          .issuer('https://x.com')
          .build(SCHEME),
      ).toThrow('sessionSecret must be at least 32 characters')
    })

    it('accepts a sessionSecret of exactly 32 characters', () => {
      const opts = new OIDCAuthenticationOptionsBuilder()
        .clientID('id')
        .clientSecret('s')
        .sessionSecret('s'.repeat(32))
        .callbackURL('https://x.com/cb')
        .discoveryURL('https://x.com')
        .issuer('https://x.com')
        .build(SCHEME)
      expect(opts.sessionSecret).toHaveLength(32)
    })
  })

  describe('secureCookie default', () => {
    it('defaults to true for an https callbackURL', () => {
      expect(minimal().build(SCHEME).secureCookie).toBe(true)
    })

    it('defaults to false for an http callbackURL (local development)', () => {
      const opts = minimal().callbackURL('http://localhost:3000/auth/callback').build(SCHEME)
      expect(opts.secureCookie).toBe(false)
    })

    it('honours an explicit override over the derived default', () => {
      expect(minimal().secureCookie(false).build(SCHEME).secureCookie).toBe(false)
      const forced = minimal().callbackURL('http://localhost:3000/auth/callback').secureCookie(true).build(SCHEME)
      expect(forced.secureCookie).toBe(true)
    })

    it('throws when callbackURL is not a valid URL', () => {
      expect(() => minimal().callbackURL('/auth/callback').build(SCHEME)).toThrow('is not a valid URL')
    })
  })

  describe('__Host- cookie prefix', () => {
    it('uses __Host- names when the cookie is secure', () => {
      const opts = minimal().build(SCHEME)
      expect(opts.sessionCookieName).toBe('__Host-oidc_OIDC_session')
      expect(opts.stateCookieName).toBe('__Host-oidc_OIDC_state')
    })

    it('falls back to unprefixed names over http, where __Host- is illegal', () => {
      const opts = minimal().callbackURL('http://localhost:3000/cb').build(SCHEME)
      expect(opts.sessionCookieName).toBe('__oidc_OIDC_session')
      expect(opts.stateCookieName).toBe('__oidc_OIDC_state')
    })

    it('honours explicit cookie names', () => {
      const opts = minimal().sessionCookieName('sess').stateCookieName('st').build(SCHEME)
      expect(opts.sessionCookieName).toBe('sess')
      expect(opts.stateCookieName).toBe('st')
    })
  })

  describe('endpoint TLS enforcement', () => {
    it('rejects a plain http issuer', () => {
      expect(() =>
        new OIDCAuthenticationOptionsBuilder()
          .clientID('id')
          .clientSecret('s')
          .sessionSecret('s'.repeat(32))
          .callbackURL('https://x.com/cb')
          .authorizationEndpoint('http://x.com/auth')
          .tokenEndpoint('https://x.com/token')
          .jwksURI('https://x.com/jwks')
          .issuer('https://x.com')
          .build(SCHEME),
      ).toThrow('must use https')
    })

    it('allows http on loopback for local development', () => {
      const opts = new OIDCAuthenticationOptionsBuilder()
        .clientID('id')
        .clientSecret('s')
        .sessionSecret('s'.repeat(32))
        .callbackURL('http://localhost:3000/cb')
        .authorizationEndpoint('http://localhost:8080/auth')
        .tokenEndpoint('http://localhost:8080/token')
        .jwksURI('http://localhost:8080/jwks')
        .issuer('http://localhost:8080')
        .build(SCHEME)
      expect(opts.issuer).toBe('http://localhost:8080')
    })
  })

  describe('defaultRedirectPath', () => {
    it('rejects a protocol-relative path', () => {
      expect(() => minimal().defaultRedirectPath('//evil.com').build(SCHEME)).toThrow(
        'must be a same-site absolute path',
      )
    })

    it('rejects an absolute off-site URL', () => {
      expect(() => minimal().defaultRedirectPath('https://evil.com').build(SCHEME)).toThrow(
        'must be a same-site absolute path',
      )
    })

    it('accepts a same-site absolute path', () => {
      expect(minimal().defaultRedirectPath('/home').build(SCHEME).defaultRedirectPath).toBe('/home')
    })

    // Regression, found by options.prop.test.ts. The URL parser strips tab/LF/CR before
    // resolving, so these clear a naive prefix check and then resolve to //evil.com.
    it.each(['/\t/evil.com', '/\n/evil.com', '/\r/evil.com'])(
      'rejects a control character smuggling a protocol-relative prefix (%j)',
      path => {
        expect(() => minimal().defaultRedirectPath(path).build(SCHEME)).toThrow('must be a same-site absolute path')
      },
    )
  })

  describe('openid scope', () => {
    it('re-adds openid when the caller replaces the default scopes', () => {
      const opts = minimal().scopes('profile', 'email').build(SCHEME)
      expect(opts.scopes).toEqual(['openid', 'profile', 'email'])
    })

    it('does not duplicate openid when already present', () => {
      const opts = minimal().scopes('openid', 'groups').build(SCHEME)
      expect(opts.scopes).toEqual(['openid', 'groups'])
    })
  })
})
