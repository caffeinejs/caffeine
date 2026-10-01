import { validateSchema } from '@caffeinejs/std/schema'
import { describe, expect, it } from 'vitest'

import { OAuthSchemeConfigSchema } from './oauth_scheme.js'
import { OIDCSchemeConfigSchema } from './oidc_scheme.js'

describe('OAuthSchemeConfigSchema', () => {
  // Plain OAuth 2.0 has no discovery document to negotiate from, so `auto` is OpenID Connect's alone.
  it('takes a token endpoint authentication method, but not `auto`', () => {
    expect(validateSchema(OAuthSchemeConfigSchema, { tokenEndpointAuthMethod: 'client_secret_basic' }).ok).toBe(true)
    expect(validateSchema(OAuthSchemeConfigSchema, { tokenEndpointAuthMethod: 'auto' }).ok).toBe(false)
    expect(validateSchema(OIDCSchemeConfigSchema, { tokenEndpointAuthMethod: 'auto' }).ok).toBe(true)
  })
})
