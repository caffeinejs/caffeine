import { newNoopLogger } from '@caffeinejs/application/logger'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWebApplication } from '../../../../application.js'
import { Router } from '../../../routing/programmatic/programmatic.js'
import { authentication } from '../../security.js'
import { Authentication } from '../auth.js'
import type { AuthenticationBuilder } from '../builder.js'
import { ErrAuthConfiguration } from '../errors.js'
import { callbackFailure, routedPath } from './routes.js'

const ISSUER = 'https://oidc-provider.example.com'

let app: { close(): Promise<void> } | undefined

afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
})

/** A strategy whose callback lands on `/auth/<name>`, lower-cased. */
function addOIDC(auth: AuthenticationBuilder<unknown>, name: string): AuthenticationBuilder<unknown> {
  return auth.addOIDC(name, opts => {
    opts
      .clientID('client')
      .clientSecret('secret')
      .sessionSecret('oidc-routes-test-secret-at-least-32ch')
      .callbackURL(`https://app.example.com/auth/${name.toLowerCase()}`)
      .authorizationEndpoint(`${ISSUER}/auth`)
      .tokenEndpoint(`${ISSUER}/token`)
      .jwksURI(`${ISSUER}/jwks`)
      .issuer(ISSUER)
  })
}

describe('the OIDC routes on the engine', () => {
  it('warns on the logger of a strategy no route names', async () => {
    const warn = vi.fn()
    const built = createWebApplication()
      .logger(b => b.use({ ...newNoopLogger(), warn }))
      .install(Authentication(auth => addOIDC(addOIDC(auth, 'Google'), 'Okta').default('Google')))
      .with(authentication())
    app = built
    await built.bootstrap()

    const warnings = warn.mock.calls.map(call => String(call[1]))
    expect(warnings.filter(message => message.includes('can never authenticate a request'))).toEqual([
      expect.stringContaining('"Okta" can never authenticate a request'),
    ])
  })

  it('warns of nothing once a route names the strategy', async () => {
    const warn = vi.fn()
    const built = createWebApplication()
      .logger(b => b.use({ ...newNoopLogger(), warn }))
      .install(Authentication(auth => addOIDC(addOIDC(auth, 'Google'), 'Okta').default('Google')))
      .with(authentication())
      .mount(
        new Router('/okta')
          .authorize({ schemes: ['Okta'] })
          .get('/')
          .handler(() => 'ok'),
      )
    app = built
    await built.bootstrap()

    expect(warn.mock.calls.some(call => String(call[1]).includes('can never authenticate a request'))).toBe(false)
  })

  // A route of the application at the callback path would answer the identity provider instead of the strategy.
  it('refuses a route at a callback path', async () => {
    const built = createWebApplication()
      .install(Authentication(auth => addOIDC(auth, 'Google')))
      .with(authentication())
      .mount(new Router('/auth/google').get('/').handler(() => 'mine'))
    app = built

    const err = await built.bootstrap().then(undefined, (e: unknown) => e)

    expect(err).toBeInstanceOf(ErrAuthConfiguration)
    expect((err as Error).message).toContain(
      'the OIDC callback or login path "/auth/google" conflicts with a registered controller route',
    )
  })
})

describe('routedPath', () => {
  it('takes the base path off a path under it, and leaves any other path alone', () => {
    expect(routedPath('/api/x', '/api')).toBe('/x')
    expect(routedPath('/x', '/api')).toBe('/x')
    expect(routedPath('/x', '')).toBe('/x')
  })
})

describe('callbackFailure', () => {
  // Whatever failed, a client probing the callback learns nothing from the answer.
  it('answers a failure with the generic body', () => {
    expect(callbackFailure(new Error('nonce mismatch'))).toEqual({
      status: 400,
      body: { error: 'Authentication failed', statusCode: 400 },
    })
  })
})
