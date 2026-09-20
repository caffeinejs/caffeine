import { health, kAuthenticationExempt, newRouter } from '@caffeinejs/http'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { Browser, type BrowserResponse } from './internal/browser/index.js'
import { bearer, localJWT } from './internal/tokens.js'

/**
 * "Every route requires a signed-in user unless it says otherwise", asked of the routes the application's router
 * never compiled: the ones a plugin registers straight on the server. They carry no `@Authorize` to forget, so the
 * fallback policy is the only thing standing in front of them.
 */

const ok = () => ({ ok: true })

describe('a fallback policy in front of routes a plugin registered on the server', () => {
  let running: RunningApp
  let token: string

  const get = (path: string, authorization?: string): Promise<BrowserResponse> =>
    new Browser().xhr(`${running.origin}${path}`, authorization === undefined ? {} : { headers: { authorization } })

  beforeAll(async () => {
    token = await bearer('alice')

    running = await startApp(app =>
      app
        .authentication(auth => auth.addJWTBearer(localJWT))
        .authorization(authz => authz.requireAuthenticatedByDefault({ except: ['/assets/'] }))
        .with(health())
        .with(() =>
          fp(
            async (instance: FastifyInstance) => {
              instance.get('/admin-ui/users', ok)
              instance.get('/assets/app.js', ok)
              instance.get('/assets-but-not-really', ok)
              instance.get('/metrics', { config: { [kAuthenticationExempt]: true } }, ok)
            },
            { name: 'e2e-plain-routes' },
          ),
        )
        .mount(newRouter('/compiled').get('/', ok)),
    )
  })

  afterAll(() => running.close())

  it('gates a plugin route exactly as it gates a compiled one that declares nothing', async () => {
    expect((await get('/compiled')).status).toBe(401)
    expect((await get('/compiled', token)).status).toBe(200)

    const anonymous = await get('/admin-ui/users')
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers['www-authenticate']).toBe('Bearer')
    expect((await get('/admin-ui/users', token)).status).toBe(200)
  })

  it('leaves open what the application listed as public, by the route’s own path and not by a look-alike', async () => {
    expect((await get('/assets/app.js')).status).toBe(200)
    expect((await get('/assets-but-not-really')).status).toBe(401)
  })

  it('leaves alone a route its author marked exempt', async () => {
    expect((await get('/metrics')).status).toBe(200)
  })

  it('never stands between an orchestrator and the health probes', async () => {
    expect((await get('/livez')).status).toBe(200)
    expect((await get('/readyz')).status).toBe(200)
    expect((await get('/startupz')).status).toBe(200)
  })

  // The not-found handler is where a single-page application's shell is served from, and where a login page
  // that is a client-side route lives. A URL that matches nothing reveals nothing either.
  it('answers 404, not 401, for a URL no route matches', async () => {
    expect((await get('/no-such-route')).status).toBe(404)
  })
})
