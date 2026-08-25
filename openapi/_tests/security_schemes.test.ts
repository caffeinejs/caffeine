import { describe, expect, it } from 'vitest'
import type { AuthSchemeDescriptor } from '@caffeinejs/http'
import { toSecurityScheme } from '../generate/security.js'

/**
 * `toSecurityScheme` maps one vendor-neutral descriptor onto its OpenAPI security scheme.
 *
 * It gets its own tests because the `oauth2` and `openIdConnect` arms lost their producer: every strategy in
 * http's OAuth family now describes itself by the session cookie it actually reads, so those arms are reached
 * only through a hand-written `.securityScheme(...)` and would otherwise go untested.
 */

describe('toSecurityScheme', () => {
  it('maps an http scheme, carrying the bearer format when one is known', () => {
    expect(toSecurityScheme({ kind: 'http', scheme: 'bearer', bearerFormat: 'JWT' }))
      .toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })

    expect(toSecurityScheme({ kind: 'http', scheme: 'basic' }))
      .toEqual({ type: 'http', scheme: 'basic' })
  })

  it('defaults an http scheme with no keyword to bearer', () => {
    expect(toSecurityScheme({ kind: 'http' })).toEqual({ type: 'http', scheme: 'bearer' })
  })

  it('maps an apiKey scheme', () => {
    expect(toSecurityScheme({ kind: 'apiKey', in: 'header', name: 'x-api-key' }))
      .toEqual({ type: 'apiKey', in: 'header', name: 'x-api-key' })
  })

  // Without both a location and a name there is nothing for a caller to send, so the scheme is dropped rather
  // than emitted as a dangling reference something else in the document points at.
  it('drops an apiKey scheme missing its location or its name', () => {
    expect(toSecurityScheme({ kind: 'apiKey', name: 'x-api-key' })).toBeUndefined()
    expect(toSecurityScheme({ kind: 'apiKey', in: 'header' })).toBeUndefined()
  })

  it('maps an openIdConnect scheme', () => {
    expect(toSecurityScheme({ kind: 'openIdConnect', openIdConnectURL: 'https://idp.example.com' }))
      .toEqual({ type: 'openIdConnect', openIdConnectUrl: 'https://idp.example.com' })
  })

  it('drops an openIdConnect scheme with no discovery URL', () => {
    expect(toSecurityScheme({ kind: 'openIdConnect' })).toBeUndefined()
  })

  it('maps an oauth2 authorization-code flow, turning the scope list into the specification\'s map', () => {
    const descriptor: AuthSchemeDescriptor = {
      kind: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationURL: 'https://idp.example.com/authorize',
          tokenURL: 'https://idp.example.com/token',
          refreshURL: 'https://idp.example.com/refresh',
          scopes: ['read', 'write'],
        },
      },
    }

    expect(toSecurityScheme(descriptor)).toEqual({
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://idp.example.com/authorize',
          tokenUrl: 'https://idp.example.com/token',
          refreshUrl: 'https://idp.example.com/refresh',
          scopes: { read: '', write: '' },
        },
      },
    })
  })

  it('drops an oauth2 scheme with no authorization-code flow', () => {
    expect(toSecurityScheme({ kind: 'oauth2' })).toBeUndefined()
    expect(toSecurityScheme({ kind: 'oauth2', flows: {} })).toBeUndefined()
  })
})

/**
 * A session cookie obtained through a sign-in is an `apiKey` by transport, and OpenAPI gives an `apiKey`
 * scheme nowhere structured to record the flow that issues it. Dropping it would leave a reader holding a
 * cookie name and no way to get one, so it becomes prose.
 */
describe('an apiKey obtained through a sign-in', () => {
  const cookie = { kind: 'apiKey', in: 'cookie', name: 'app_session' } as const

  it('describes the OAuth 2.0 sign-in that issues it, scopes included', () => {
    const scheme = toSecurityScheme({
      ...cookie,
      flows: {
        authorizationCode: {
          authorizationURL: 'https://github.com/login/oauth/authorize',
          tokenURL: 'https://github.com/login/oauth/access_token',
          scopes: ['read:user', 'user:email'],
        },
      },
    })

    expect(scheme).toMatchObject({ type: 'apiKey', in: 'cookie', name: 'app_session' })
    expect((scheme as { description: string }).description)
      .toBe(
        'Session cookie issued after an OAuth 2.0 sign-in at https://github.com/login/oauth/authorize '
        + '(scopes: read:user, user:email). Sign in through the browser; the cookie is then sent automatically.',
      )
  })

  it('omits the scope list when the scheme requests none', () => {
    const scheme = toSecurityScheme({
      ...cookie,
      flows: {
        authorizationCode: {
          authorizationURL: 'https://idp.example.com/authorize',
          tokenURL: 'https://idp.example.com/token',
          scopes: [],
        },
      },
    })

    expect((scheme as { description: string }).description).not.toContain('scopes')
  })

  it('describes an OpenID Connect sign-in by its discovery document', () => {
    const scheme = toSecurityScheme({ ...cookie, openIdConnectURL: 'https://accounts.google.com' })

    expect((scheme as { description: string }).description)
      .toContain('OpenID Connect sign-in against https://accounts.google.com')
  })

  it('says nothing extra for an apiKey that names no sign-in', () => {
    expect(toSecurityScheme(cookie)).toEqual({ type: 'apiKey', in: 'cookie', name: 'app_session' })
  })

  // An author who wrote their own description meant it; the synthesized sentence is a fallback, not a prefix.
  it('lets an explicit description win over the synthesized one', () => {
    const scheme = toSecurityScheme({
      ...cookie,
      description: 'Ask an administrator.',
      openIdConnectURL: 'https://accounts.google.com',
    })

    expect((scheme as { description: string }).description).toBe('Ask an administrator.')
  })
})
