import { validateSchema } from '@caffeinejs/std/schema'
import { describe, expect, it, vi } from 'vitest'

import {
  BasicSchemeConfigSchema,
  CookieSchemeConfigSchema,
  JWTSchemeConfigSchema,
  OAuthSchemeConfigSchema,
  OIDCSchemeConfigSchema,
  OpaqueSchemeConfigSchema,
} from '../../schema.js'
import { SCHEME_CONFIG, applyScheme, type AuthSchemeConfig } from './config.js'
import type { CookieAuthenticationOptionsBuilder } from './cookie/cookie_options.js'

const SCHEMAS = {
  jwt: JWTSchemeConfigSchema,
  basic: BasicSchemeConfigSchema,
  cookie: CookieSchemeConfigSchema,
  opaque: OpaqueSchemeConfigSchema,
  oidc: OIDCSchemeConfigSchema,
  oauth: OAuthSchemeConfigSchema,
  github: OAuthSchemeConfigSchema,
} as const

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

  // A key in the schema with no setter validates and then goes nowhere, which reads as configured and is not.
  it.each(Object.keys(SCHEME_CONFIG) as Array<keyof typeof SCHEME_CONFIG>)(
    'has a setter for every key the %s schema declares',
    kind => {
      const declared = Object.keys(SCHEMAS[kind].properties)

      expect(Object.keys(SCHEME_CONFIG[kind]).toSorted()).toEqual(declared.toSorted())
    },
  )

  // Plain OAuth 2.0 has no discovery document to negotiate from, so `auto` is OpenID Connect's alone.
  it('takes a token endpoint authentication method for OAuth 2.0, but has nothing to pick one from', () => {
    expect(validateSchema(OAuthSchemeConfigSchema, { tokenEndpointAuthMethod: 'client_secret_basic' }).ok).toBe(true)
    expect(validateSchema(OAuthSchemeConfigSchema, { tokenEndpointAuthMethod: 'auto' }).ok).toBe(false)
    expect(validateSchema(OIDCSchemeConfigSchema, { tokenEndpointAuthMethod: 'auto' }).ok).toBe(true)
  })
})
