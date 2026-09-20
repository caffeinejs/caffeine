import { describe, expect, it, vi } from 'vitest'

import { SCHEME_CONFIG, SCHEME_SCHEMAS, applyScheme, validated } from './config.js'
import type { CookieAuthenticationOptionsBuilder } from './cookie/cookie_options.js'

/**
 * What reaches a scheme's options builder from the configuration tree. The tree may carry text where an option is a
 * boolean or a number — an environment variable is text, and the application's schema may leave a scheme's keys
 * open — so the kind's own schema is what types the values, on the way in.
 */
describe('applyScheme', () => {
  it('hands each option the type it takes, whatever the tree carried', () => {
    const values = validated(
      SCHEME_CONFIG.cookie,
      { secure: 'false', rememberMe: 'true', maxAge: '3600', cookieName: 'session' },
      'authentication scheme "Cookie"',
    )

    expect(values).toEqual({ secure: false, rememberMe: true, maxAge: 3600, cookieName: 'session' })
  })

  it('calls the setter of every key the tree carries, and of no other', () => {
    const builder = { secure: vi.fn(), maxAge: vi.fn(), cookieName: vi.fn() }

    applyScheme(
      builder as unknown as CookieAuthenticationOptionsBuilder,
      SCHEME_CONFIG.cookie as never,
      { secure: 'false', maxAge: '60', cookieName: undefined },
      'authentication scheme "Cookie"',
    )

    expect(builder.secure).toHaveBeenCalledWith(false)
    expect(builder.maxAge).toHaveBeenCalledWith(60)
    expect(builder.cookieName).not.toHaveBeenCalled()
  })

  // Dropped instead, a misspelt key leaves the operator believing a check is on that never ran.
  it('refuses a key the kind does not have, naming it and the ones it has', () => {
    expect(() => validated(SCHEME_CONFIG.jwt, { audiance: 'api' }, 'authentication scheme "jwt"')).toThrow(
      /Cannot configure authentication scheme "jwt": "audiance" is not an option of it \(options: .*"audience"/,
    )
  })

  it('refuses a value the option does not take, naming the option', () => {
    expect(() => validated(SCHEME_CONFIG.oidc, { allowPlainPkce: 'perhaps' }, 'authentication scheme "sso"')).toThrow(
      /Cannot configure authentication scheme "sso": allowPlainPkce/,
    )
  })

  it('applies nothing when the tree carries nothing for the scheme', () => {
    expect(validated(SCHEME_CONFIG.basic, {}, 'authentication scheme "Basic"')).toEqual({})
  })

  // A key in the schema with no setter validates and then goes nowhere, which reads as configured and is not.
  it.each(Object.keys(SCHEME_CONFIG) as Array<keyof typeof SCHEME_CONFIG>)(
    'has a setter for every key the %s schema declares',
    kind => {
      const declared = Object.keys(SCHEME_SCHEMAS[kind].properties)

      expect(Object.keys(SCHEME_CONFIG[kind].appliers).toSorted()).toEqual(declared.toSorted())
    },
  )

  // Plain OAuth 2.0 has no discovery document to negotiate from, so `auto` is OpenID Connect's alone.
  it('takes a token endpoint authentication method for OAuth 2.0, but has nothing to pick one from', () => {
    const where = 'authentication scheme "GitHub"'

    expect(validated(SCHEME_CONFIG.oauth, { tokenEndpointAuthMethod: 'client_secret_basic' }, where)).toEqual({
      tokenEndpointAuthMethod: 'client_secret_basic',
    })
    expect(() => validated(SCHEME_CONFIG.oauth, { tokenEndpointAuthMethod: 'auto' }, where)).toThrow(
      /tokenEndpointAuthMethod/,
    )
    expect(validated(SCHEME_CONFIG.oidc, { tokenEndpointAuthMethod: 'auto' }, where)).toEqual({
      tokenEndpointAuthMethod: 'auto',
    })
  })
})
