import { Day, Hour, Minute, Second } from '@caffeinejs/std/duration'
import { describe, expect, it, vi } from 'vitest'

import { SCHEME_CONFIG, applyScheme, refresh, type AuthSchemeConfig } from './config.js'
import { CookieAuthenticationOptionsBuilder } from './cookie/cookie_options.js'
import { JWTAuthenticationOptionsBuilder } from './jwt/jwt_options.js'
import { OAuth2AuthenticationOptionsBuilder } from './oauth/options.js'
import { OIDCAuthenticationOptionsBuilder } from './oidc/options.js'
import { RefreshTokenOptionsBuilder } from './refresh/refresh_options.js'

const SESSION_SECRET = 'a-session-secret-of-at-least-32-characters'

/** What reaches a scheme's options builder from a scheme's configuration block. */
describe('applyScheme', () => {
  it('calls the setter of every key the block carries, and of no other', () => {
    const builder = { secure: vi.fn(), maxAge: vi.fn(), cookieName: vi.fn() }

    applyScheme(builder as unknown as CookieAuthenticationOptionsBuilder, SCHEME_CONFIG.cookie, {
      secure: false,
      maxAge: 1 * Minute,
      cookieName: undefined,
    })

    expect(builder.secure).toHaveBeenCalledWith(false)
    expect(builder.maxAge).toHaveBeenCalledWith(1 * Minute)
    expect(builder.cookieName).not.toHaveBeenCalled()
  })

  // A scheme's block accepts every kind's keys, because only the `addX(...)` call knows the kind.
  it('does not read a key another kind declares', () => {
    const builder = { secure: vi.fn() }
    const block: AuthSchemeConfig = { secure: true, audience: 'api' }

    applyScheme(builder as unknown as CookieAuthenticationOptionsBuilder, SCHEME_CONFIG.cookie, block)

    expect(builder.secure).toHaveBeenCalledWith(true)
  })

  it('applies nothing when the configuration carries nothing for the scheme', () => {
    const builder = { secure: vi.fn() }

    applyScheme(builder as unknown as CookieAuthenticationOptionsBuilder, SCHEME_CONFIG.cookie, undefined)

    expect(builder.secure).not.toHaveBeenCalled()
  })

  // Where a deployment scopes the cookies of an OpenID Connect scheme, which no provider is needed to see.
  it("carries an OpenID Connect scheme's cookie attributes to its options", () => {
    const builder = new OIDCAuthenticationOptionsBuilder()
      .clientID('id')
      .clientSecret('secret')
      .sessionSecret('a-session-secret-of-at-least-32-characters')
      .callbackURL('https://app.test/callback')
      .discoveryURL('https://idp.test')
      .issuer('https://idp.test')

    applyScheme(builder, SCHEME_CONFIG.oidc, {
      cookieDomain: 'app.test',
      cookiePartitioned: true,
      cookiePriority: 'high',
    })

    expect(builder.build('oidc')).toMatchObject({
      cookieDomain: 'app.test',
      cookiePartitioned: true,
      cookiePriority: 'high',
      sessionCookieName: '__Secure-oidc_oidc_session',
    })
  })

  // Each span in the tree reaches the option it names as the Duration it was read as, never a count of seconds.
  describe('the spans of time a block carries', () => {
    it('reach a JWT scheme', () => {
      const builder = new JWTAuthenticationOptionsBuilder().secret(SESSION_SECRET).allowAnyIssuer().allowAnyAudience()

      applyScheme(builder, SCHEME_CONFIG.jwt, { expiresIn: 15 * Minute })

      expect(builder.build().serviceOptions).toMatchObject({ expiresIn: 15 * Minute })
    })

    it('reach a cookie scheme', () => {
      const builder = new CookieAuthenticationOptionsBuilder().sessionSecret(SESSION_SECRET)

      applyScheme(builder, SCHEME_CONFIG.cookie, {
        maxAge: 2 * Hour,
        rememberMe: true,
        rememberMeMaxAge: 7 * Day,
        rememberMeAbsoluteMaxAge: 30 * Day,
        rememberMeRotationGrace: 10 * Second,
      })

      expect(builder.build()).toMatchObject({
        maxAge: 2 * Hour,
        rememberMeMaxAge: 7 * Day,
        rememberMeAbsoluteMaxAge: 30 * Day,
        rememberMeRotationGrace: 10 * Second,
      })
    })

    it('reach an OpenID Connect scheme', () => {
      const builder = new OIDCAuthenticationOptionsBuilder()
        .clientID('id')
        .clientSecret('secret')
        .sessionSecret(SESSION_SECRET)
        .callbackURL('https://app.test/callback')
        .discoveryURL('https://idp.test')
        .issuer('https://idp.test')

      applyScheme(builder, SCHEME_CONFIG.oidc, {
        sessionCookieTtl: 2 * Hour,
        clockTolerance: 30 * Second,
        httpTimeout: 5 * Second,
        discoveryCacheTtl: 10 * Minute,
        maxAge: 5 * Minute,
      })

      expect(builder.build('oidc')).toMatchObject({
        sessionCookieTTL: 2 * Hour,
        clockTolerance: 30 * Second,
        httpTimeout: 5 * Second,
        discoveryCacheTTL: 10 * Minute,
        maxAge: 5 * Minute,
      })
    })

    it('reach an OAuth 2.0 scheme', () => {
      const builder = new OAuth2AuthenticationOptionsBuilder()
        .clientID('id')
        .clientSecret('secret')
        .sessionSecret(SESSION_SECRET)
        .callbackURL('https://app.test/callback')
        .authorizationEndpoint('https://idp.test/authorize')
        .tokenEndpoint('https://idp.test/token')
        .userInfoEndpoint('https://idp.test/me')

      applyScheme(builder, SCHEME_CONFIG.oauth, { sessionCookieTtl: 2 * Hour, httpTimeout: 5 * Second })

      expect(builder.build('oauth')).toMatchObject({ sessionCookieTTL: 2 * Hour, httpTimeout: 5 * Second })
    })

    it('reach refresh tokens', () => {
      const builder = new RefreshTokenOptionsBuilder().resolve(() => null)

      applyScheme(builder, refresh, { accessTtl: 15 * Minute, refreshTtl: 30 * Day, absoluteTtl: 90 * Day })

      expect(builder.build()).toMatchObject({ accessTTL: 15 * Minute, refreshTTL: 30 * Day, absoluteTTL: 90 * Day })
    })
  })
})
