import { Claim, Identity, Principal, newRouter } from '@caffeinejs/http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { Browser, type BrowserResponse } from './internal/browser/index.js'

/** HTTP Basic (RFC 7617) over a real socket. No external system, so this spec never skips. */

const USERS = new Map([
  ['admin', 'admin123'],
  // The first colon ends the user-id; everything after it, colons included, is the password.
  ['colon', 'pa:ss:word'],
  ['jürgen', 'pässwörd-日本語'],
])

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
}

describe('HTTP Basic authentication', () => {
  let running: RunningApp

  const get = (authorization?: string): Promise<BrowserResponse> =>
    new Browser().xhr(`${running.origin}/docs`, authorization === undefined ? {} : { headers: { authorization } })

  beforeAll(async () => {
    running = await startApp(app =>
      app
        .authentication(auth =>
          auth.addBasic(b =>
            b
              .realm('Docs')
              .validate((_ctx, user, password) =>
                USERS.get(user) === password
                  ? new Principal(true, new Identity('Basic', true, [new Claim('sub', user, '')]))
                  : null,
              ),
          ),
        )
        .mount(
          newRouter('/docs')
            .authorize({})
            .get('/', ctx => ({ sub: ctx.user.findFirst('sub')?.value })),
        ),
    )
  })

  afterAll(() => running.close())

  it('challenges with the realm when no credentials are sent', async () => {
    const response = await get()

    expect(response.status).toBe(401)
    expect(response.headers['www-authenticate']).toBe('Basic realm="Docs"')
  })

  it('accepts valid credentials', async () => {
    const response = await get(basic('admin', 'admin123'))

    expect(response.status).toBe(200)
    expect(response.json()).toEqual({ sub: 'admin' })
  })

  it('reads the scheme name case-insensitively', async () => {
    const credentials = Buffer.from('admin:admin123').toString('base64')

    expect((await get(`basic ${credentials}`)).status).toBe(200)
    expect((await get(`BASIC ${credentials}`)).status).toBe(200)
  })

  it('splits on the first colon only, so a password may contain one', async () => {
    expect((await get(basic('colon', 'pa:ss:word'))).status).toBe(200)
    expect((await get(basic('colon', 'pa'))).status).toBe(401)
  })

  it('decodes credentials as UTF-8', async () => {
    const response = await get(basic('jürgen', 'pässwörd-日本語'))

    expect(response.status).toBe(200)
    expect(response.json()).toEqual({ sub: 'jürgen' })
  })

  it.each([
    ['a wrong password', basic('admin', 'wrong')],
    ['an unknown user', basic('mallory', 'admin123')],
    ['credentials with no colon', `Basic ${Buffer.from('admin-admin123').toString('base64')}`],
    ['credentials that are not base64', 'Basic %%%not-base64%%%'],
    ['an empty credential', 'Basic '],
    ['a credential of another scheme', 'Bearer admin:admin123'],
  ])('refuses %s with a challenge, never a server error', async (_label, authorization) => {
    const response = await get(authorization)

    expect(response.status).toBe(401)
    expect(response.headers['www-authenticate']).toBe('Basic realm="Docs"')
  })
})
