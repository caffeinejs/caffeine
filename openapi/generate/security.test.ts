import type { IRoute } from '@caffeinejs/http'
import { describe, expect, it } from 'vitest'

import { defaultOpenAPIOptions } from '../options.js'
import { buildSecuritySchemes, deriveSecurity, toSecurityScheme } from './security.js'

describe('toSecurityScheme', () => {
  // The description is how a registration explains itself to a reader; dropping it loses the only prose a
  // consumer shows next to the scheme.
  it('carries the descriptor description onto every scheme type', () => {
    const description = 'Issued by the platform team'

    expect(toSecurityScheme({ kind: 'http', scheme: 'basic', description })).toEqual({
      type: 'http',
      scheme: 'basic',
      description,
    })
    expect(
      toSecurityScheme({ kind: 'openIdConnect', openIdConnectURL: 'https://idp.example.com', description }),
    ).toEqual({ type: 'openIdConnect', openIdConnectUrl: 'https://idp.example.com', description })
    expect(
      toSecurityScheme({
        kind: 'oauth2',
        flows: { authorizationCode: { authorizationURL: 'https://a.example', tokenURL: 'https://t.example' } },
        description,
      }),
    ).toEqual({
      type: 'oauth2',
      flows: {
        authorizationCode: { authorizationUrl: 'https://a.example', tokenUrl: 'https://t.example', scopes: {} },
      },
      description,
    })
  })
})

describe('buildSecuritySchemes', () => {
  // A dangling scheme would make the document invalid; a missing one only leaves a route undescribed.
  it('leaves out a registered scheme that cannot be described', () => {
    const descriptors = new Map([
      ['Bearer', { kind: 'http' as const, scheme: 'bearer' }],
      ['Incomplete', { kind: 'apiKey' as const }],
    ])

    expect(buildSecuritySchemes(descriptors, defaultOpenAPIOptions())).toEqual({
      Bearer: { type: 'http', scheme: 'bearer' },
    })
  })

  it('ignores the registered schemes when derivation is off, keeping the declared ones', () => {
    const descriptors = new Map([['Bearer', { kind: 'http' as const }]])
    const options = {
      ...defaultOpenAPIOptions(),
      deriveSecuritySchemes: false,
      securitySchemes: { Key: { type: 'apiKey' as const, in: 'header' as const, name: 'x-key' } },
    }

    expect(buildSecuritySchemes(descriptors, options)).toEqual({
      Key: { type: 'apiKey', in: 'header', name: 'x-key' },
    })
  })

  it('returns nothing when no scheme is registered or declared', () => {
    expect(buildSecuritySchemes(undefined, defaultOpenAPIOptions())).toBe(undefined)
  })
})

describe('deriveSecurity', () => {
  const route = (authorization: Partial<IRoute<unknown>['authorization']>) =>
    ({ authorization: { hasProtection: true, schemes: [], ...authorization } }) as IRoute<unknown>

  // A requirement naming no defined scheme would be a dangling reference, so the route inherits instead.
  it('states nothing for a protected route that resolved no scheme', () => {
    expect(deriveSecurity(route({ schemes: [] }), { Bearer: { type: 'http', scheme: 'bearer' } })).toBe(undefined)
  })

  // A Forward strategy picks between real schemes per request and cannot be described itself, so every described
  // scheme is an alternative, which is what a forward means.
  it('offers every described scheme when the route resolved only undescribable ones', () => {
    expect(
      deriveSecurity(route({ schemes: ['Forward'] }), {
        Bearer: { type: 'http', scheme: 'bearer' },
        Key: { type: 'apiKey', in: 'header', name: 'x-key' },
      }),
    ).toEqual([{ Bearer: [] }, { Key: [] }])
  })

  it('offers one empty-scoped requirement when the route declared no roles', () => {
    expect(
      deriveSecurity(route({ schemes: ['OIDC'], options: undefined }), {
        OIDC: { type: 'openIdConnect', openIdConnectUrl: 'https://idp.example.com' },
      }),
    ).toEqual([{ OIDC: [] }])
  })
})
