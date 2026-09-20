import {
  AuthenticateResult,
  AuthenticationTicket,
  BaseAuthenticationHandler,
  Claim,
  type Context,
  Identity,
  Principal,
  newRouter,
} from '@caffeinejs/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { Browser, type BrowserResponse } from './internal/browser/index.js'
import { bearer, localJWT } from './internal/tokens.js'

/**
 * Routes that name their own authentication schemes. Three schemes on three transports, so a caller can present
 * any combination: a JWT bearer (the application default), HTTP Basic, and an API key in a header of its own.
 */

const API_KEYS = new Map([['key-of-the-partner', 'partner']])

class APIKeyHandler extends BaseAuthenticationHandler<object> {
  constructor() {
    super({})
  }

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
    const key = ctx.req.header('x-api-key')
    if (key === undefined) {
      return AuthenticateResult.none()
    }

    const subject = API_KEYS.get(key)
    if (subject === undefined) {
      return AuthenticateResult.fail(new Error('Unknown API key'))
    }

    const principal = new Principal(true, new Identity('APIKey', true, [new Claim('sub', subject, '')]))
    return AuthenticateResult.success(new AuthenticationTicket(principal, 'APIKey'))
  }
}

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
}

describe('routes that name their authentication schemes', () => {
  let running: RunningApp

  const get = (path: string, headers: Record<string, string> = {}): Promise<BrowserResponse> =>
    new Browser().xhr(`${running.origin}${path}`, { headers })

  const identities = (ctx: Context) => ({
    identities: ctx.user.identities.map(identity => identity.authenticationType),
    subjects: ctx.user.findAll('sub').map(claim => claim.value),
  })

  beforeAll(async () => {
    running = await startApp(app =>
      app
        .authentication(auth =>
          auth
            .addJWTBearer(localJWT)
            .addBasic(b =>
              b
                .realm('Reports')
                .validate((_ctx, user, password) =>
                  user === 'analyst' && password === 'analyst123'
                    ? new Principal(true, new Identity('Basic', true, [new Claim('sub', user, '')]))
                    : null,
                ),
            )
            .addStrategy('APIKey', new APIKeyHandler())
            .default('Bearer'),
        )
        .mount(newRouter('/default').authorize({}).get('/', identities))
        .mount(
          newRouter('/either-header')
            .authorize({ schemes: ['Basic', 'Bearer'] })
            .get('/', identities),
        )
        .mount(
          newRouter('/reports')
            .authorize({ schemes: ['Basic', 'APIKey'] })
            .get('/', identities),
        ),
    )
  })

  afterAll(() => running.close())

  it('accepts any one of the schemes the route names', async () => {
    const viaBasic = await get('/reports', { authorization: basic('analyst', 'analyst123') })
    expect(viaBasic.status).toBe(200)
    expect(viaBasic.json()).toEqual({ identities: ['Basic'], subjects: ['analyst'] })

    const viaKey = await get('/reports', { 'x-api-key': 'key-of-the-partner' })
    expect(viaKey.status).toBe(200)
    expect(viaKey.json()).toEqual({ identities: ['APIKey'], subjects: ['partner'] })
  })

  it('merges the identities of every named scheme the caller satisfied, in the order the route named them', async () => {
    const response = await get('/reports', {
      authorization: basic('analyst', 'analyst123'),
      'x-api-key': 'key-of-the-partner',
    })

    expect(response.status).toBe(200)
    expect(response.json()).toEqual({ identities: ['Basic', 'APIKey'], subjects: ['analyst', 'partner'] })
  })

  // Naming schemes narrows a route. A caller the default scheme would have admitted is nobody here.
  it('does not let a credential of the default scheme through', async () => {
    const token = await bearer('alice')

    expect((await get('/default', { authorization: token })).status).toBe(200)
    expect((await get('/reports', { authorization: token })).status).toBe(401)
  })

  it('does not let a named scheme’s credential through on a route that names none', async () => {
    expect((await get('/default', { authorization: basic('analyst', 'analyst123') })).status).toBe(401)
    expect((await get('/default', { 'x-api-key': 'key-of-the-partner' })).status).toBe(401)
  })

  it('refuses a caller one scheme rejects even when it is the only credential sent', async () => {
    expect((await get('/reports', { authorization: basic('analyst', 'wrong') })).status).toBe(401)
    expect((await get('/reports', { 'x-api-key': 'not-a-key' })).status).toBe(401)
  })

  it('still admits a caller one scheme rejects when another accepts them', async () => {
    const response = await get('/reports', {
      authorization: basic('analyst', 'wrong'),
      'x-api-key': 'key-of-the-partner',
    })

    expect(response.status).toBe(200)
    expect(response.json()).toEqual({ identities: ['APIKey'], subjects: ['partner'] })
  })

  // A client picks the challenge it can answer, so it has to be shown every one the route accepts (RFC 9110
  // §11.6.1), not whichever scheme happened to write its header last.
  it('advertises every scheme the route names when it challenges', async () => {
    const response = await get('/either-header')

    expect(response.status).toBe(401)
    expect(response.headersDistinct['www-authenticate']).toEqual(['Basic realm="Reports"', 'Bearer'])
  })

  it('challenges with a scheme the route names, not with the application default', async () => {
    const response = await get('/reports')

    expect(response.status).toBe(401)
    expect(response.headers['www-authenticate']).toContain('Basic realm="Reports"')

    expect((await get('/default')).headers['www-authenticate']).toBe('Bearer')
  })
})
