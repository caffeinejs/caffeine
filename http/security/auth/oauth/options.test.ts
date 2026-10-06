import { describe, expect, it } from 'vitest'

import { OAuth2AuthenticationOptionsBuilder } from './options.js'

const SCHEME = 'Provider'

function minimal(): OAuth2AuthenticationOptionsBuilder {
  return new OAuth2AuthenticationOptionsBuilder()
    .clientID('cid')
    .clientSecret('csecret')
    .sessionSecret('oauth2-test-secret-at-least-32-chars!!')
    .callbackURL('https://app.example.com/auth/provider')
    .authorizationEndpoint('https://provider.example.com/authorize')
    .tokenEndpoint('https://provider.example.com/token')
    .userInfoEndpoint('https://provider.example.com/me')
}

describe('OAuth2AuthenticationOptionsBuilder.build(SCHEME)', () => {
  // The browser lands here after signing in, so a path that leaves the origin is an open redirect. One written with
  // `~/` stays on it but means nothing here: the base path goes in front already, and taken as it is, it would
  // reach the browser as a relative URL.
  describe('defaultRedirectPath', () => {
    it.each(['//evil.example', 'https://evil.example/home', '~/home'])('rejects %s', path => {
      expect(() => minimal().defaultRedirectPath(path).build(SCHEME)).toThrow('must be a same-site absolute path')
    })

    it('accepts a same-site absolute path, and defaults to the root', () => {
      expect(minimal().defaultRedirectPath('/home').build(SCHEME).defaultRedirectPath).toBe('/home')
      expect(minimal().build(SCHEME).defaultRedirectPath).toBe('/')
    })
  })

  // Below the floor, the keys the session and state cookies are sealed with can be brute-forced.
  describe('sessionSecret', () => {
    it('takes a list, the first sealing', () => {
      const secrets = ['oauth2-test-secret-at-least-32-chars!!', 'an-older-oauth2-secret-of-32-chars!!']
      expect(minimal().sessionSecret(secrets).build(SCHEME).sessionSecret).toEqual(secrets)
    })

    it.each<[string, string | string[], string]>([
      ['a short secret', 's'.repeat(31), 'sessionSecret must be at least 32 characters'],
      [
        'a short entry of a list by its position',
        ['oauth2-test-secret-at-least-32-chars!!', 'short'],
        'sessionSecret 1 of the list must be at least 32 characters',
      ],
      ['an empty list', [], 'the list of sessionSecret is empty'],
    ])('refuses %s', (_what, secret, message) => {
      expect(() => minimal().sessionSecret(secret).build(SCHEME)).toThrow(`Cannot configure OAuth2: ${message}`)
    })
  })

  describe('cookies', () => {
    it('scopes them as configured', () => {
      const opts = minimal().cookieDomain('example.com').cookiePartitioned().cookiePriority('high').build(SCHEME)

      expect(opts).toMatchObject({ cookieDomain: 'example.com', cookiePartitioned: true, cookiePriority: 'high' })
    })

    // `__Host-` refuses a Domain, so a cookie given one keeps the Secure guarantee under `__Secure-` instead.
    it('names them "__Secure-" rather than "__Host-" when they are given a domain', () => {
      expect(minimal().build(SCHEME).sessionCookieName).toBe('__Host-oauth2_Provider_session')

      const opts = minimal().cookieDomain('example.com').build(SCHEME)
      expect(opts.sessionCookieName).toBe('__Secure-oauth2_Provider_session')
      expect(opts.stateCookieName).toBe('__Secure-oauth2_Provider_state')
    })

    // A cookie a browser would drop fails as the application starts, not as a sign-in that never sticks.
    it.each<[string, (o: OAuth2AuthenticationOptionsBuilder) => OAuth2AuthenticationOptionsBuilder, string]>([
      [
        'an explicit "__Host-" name with a domain',
        o => o.sessionCookieName('__Host-sess').cookieDomain('example.com'),
        'sessionCookieName "__Host-sess": a "__Host-" cookie needs',
      ],
      [
        'partitioned cookies without Secure',
        o => o.secureCookie(false).cookiePartitioned(),
        'sessionCookieName "__oauth2_Provider_session": Partitioned needs Secure',
      ],
      [
        'a domain a header cannot carry',
        o => o.cookieDomain('bad domain'),
        'sessionCookieName "__Secure-oauth2_Provider_session": its Domain is not a valid domain name',
      ],
    ])('refuses %s', (_what, configure, message) => {
      expect(() => configure(minimal()).build(SCHEME)).toThrow(`Cannot configure OAuth2: ${message}`)
    })
  })
})
