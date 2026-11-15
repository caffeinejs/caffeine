import { afterEach, describe, expect, it } from 'vitest'

import { Authentication } from '../../../../index.js'
import { authentication, createWebApplication, newRouter } from '../../../../platform/fastify/index.js'

// On Fastify alone: a gate on a router claims the OIDC routes when the root gate opts out, and serves them at the
// server's root. On the web-standards engine only a gate on a server registers them.

const ISSUER = 'https://oidc-provider.example.com'

let app: { close(): Promise<void> } | undefined

afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
})

describe('the gate that claims the login and callback routes, on Fastify', () => {
  it('leaves them to a later gate when the root gate opts out', async () => {
    const built = createWebApplication()
      .install(
        Authentication(auth =>
          auth.addOIDC('Google', opts => {
            opts
              .clientID('oidc-test-client-id')
              .clientSecret('oidc-client-secret')
              .sessionSecret('oidc-integration-test-secret-32ch!!')
              .callbackURL('https://oidc-app.example.com/oidc/callback')
              .authorizationEndpoint(`${ISSUER}/auth`)
              .tokenEndpoint(`${ISSUER}/token`)
              .jwksURI(`${ISSUER}/jwks`)
              .issuer(ISSUER)
          }),
        ),
      )
      .with(authentication(g => g.oidcRoutes(false)))
      .mount(
        newRouter('/oidc-claim-scoped')
          .with(authentication(g => g.name('scoped')))
          .get('/', () => ({ ok: true })),
      )
    app = built
    await built.bootstrap()

    const res = await built.request('/oidc/callback/login?returnTo=/x')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain(`${ISSUER}/auth`)
  })
})
