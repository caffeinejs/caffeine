import { describe, expect, it, vi } from 'vitest'

import { SCHEME_CONFIG, applyScheme, type AuthSchemeConfig } from './config.js'
import type { CookieAuthenticationOptionsBuilder } from './cookie/cookie_options.js'
import { OIDCAuthenticationOptionsBuilder } from './oidc/options.js'

/** What reaches a scheme's options builder from a scheme's configuration block. */
describe('applyScheme', () => {
  it('calls the setter of every key the block carries, and of no other', () => {
    const builder = { secure: vi.fn(), maxAge: vi.fn(), cookieName: vi.fn() }

    applyScheme(builder as unknown as CookieAuthenticationOptionsBuilder, SCHEME_CONFIG.cookie, {
      secure: false,
      maxAge: 60,
      cookieName: undefined,
    })

    expect(builder.secure).toHaveBeenCalledWith(false)
    expect(builder.maxAge).toHaveBeenCalledWith(60)
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
})
