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
})
