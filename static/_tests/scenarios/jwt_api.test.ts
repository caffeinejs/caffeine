import { JWTService, newRouter, type WebApplication } from '@caffeinejs/http'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { staticFiles } from '../../index.js'
import { CURL, dist, expectNotFoundJSON, IFRAME, isolated, NAVIGATION, XHR } from './_headers.js'

const SECRET = 'jwt-hs256-secret-with-more-than-32-bytes-of-text'
const ISSUER = 'https://issuer.test'
const AUDIENCE = 'spa-api'

const signer = new JWTService({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE, expiresIn: '5m' })

/**
 * A public single-page application whose API takes bearer tokens: the page is for everyone, every call it makes
 * carries a token, and a token is never redirected anywhere.
 */
function publicSPA(): WebApplication {
  const api = newRouter('/api')
    .authorize({})
    .get('/me', ctx => ({ sub: ctx.user.findFirst('sub')?.value }))
    .mount(
      newRouter('/admin')
        .authorize({ roles: ['admin'] })
        .get('/', () => ({ ok: true })),
    )

  return isolated()
    .authentication(a => a.addJWTBearer(j => j.secret(SECRET).issuer(ISSUER).audience(AUDIENCE)))
    .with(staticFiles(s => s.spa(dist)))
    .mount(api) as WebApplication
}

describe('public SPA with a bearer-token API', () => {
  let app: WebApplication
  let user: string
  let admin: string

  beforeAll(async () => {
    user = `Bearer ${await signer.sign({}, { subject: 'bob' })}`
    admin = `Bearer ${await signer.sign({ roles: ['admin'] }, { subject: 'ann' })}`
  })

  afterEach(async () => {
    await app?.close()
  })

  it('serves the shell to a navigation', async () => {
    app = publicSPA()
    await app.ready()

    const res = await app.fetch('/settings', { headers: NAVIGATION })

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root">')
  })

  it('challenges an API call without a token with 401 and WWW-Authenticate', async () => {
    app = publicSPA()
    await app.ready()

    const res = await app.fetch('/api/me', { headers: XHR })

    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/)
  })

  it('authenticates an API call carrying a token', async () => {
    app = publicSPA()
    await app.ready()

    const res = await app.fetch('/api/me', { headers: { ...XHR, authorization: user } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sub: 'bob' })
  })

  it('forbids a token without the role, as an error and not as the page', async () => {
    app = publicSPA()
    await app.ready()

    const forbidden = await app.fetch('/api/admin', { headers: { ...XHR, authorization: user } })
    expect(forbidden.status).toBe(403)
    expect(forbidden.headers.get('content-type') ?? '').not.toMatch(/text\/html/)

    const allowed = await app.fetch('/api/admin', { headers: { ...XHR, authorization: admin } })
    expect(allowed.status).toBe(200)
  })

  // A bearer scheme has nowhere to redirect to, and the shell must not step in for a URL the server owns.
  it('answers a navigation to a protected API route with 401, not the shell', async () => {
    app = publicSPA()
    await app.ready()

    const res = await app.fetch('/api/admin', { headers: NAVIGATION })

    expect(res.status).toBe(401)
  })

  it('keeps an API miss a JSON 404 for a caller holding a valid token', async () => {
    app = publicSPA()
    await app.ready()

    await expectNotFoundJSON(await app.fetch('/api/typo', { headers: { ...XHR, authorization: user } }))
  })

  it('answers a mistyped fetch of a client route with 404 rather than a page JavaScript cannot parse', async () => {
    app = publicSPA()
    await app.ready()

    await expectNotFoundJSON(await app.fetch('/settings', { headers: XHR }))
  })

  // `Accept: */*` is what curl, axios and most SDKs send; none of them can do anything with a document.
  it('does not take a bare wildcard Accept for a document request', async () => {
    app = publicSPA()
    await app.ready()

    await expectNotFoundJSON(await app.fetch('/settings', { headers: CURL }))
  })

  it('serves the shell to a request that says nothing about what it wants', async () => {
    app = publicSPA()
    await app.ready()

    const res = await app.fetch('/settings')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<div id="root">')
  })

  it('serves the shell into an iframe', async () => {
    app = publicSPA()
    await app.ready()

    const res = await app.fetch('/settings', { headers: IFRAME })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
  })

  it('answers HEAD with the headers and no body', async () => {
    app = publicSPA()
    await app.ready()

    const res = await app.fetch('/settings', { method: 'HEAD', headers: NAVIGATION })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(await res.text()).toBe('')
  })

  it('revalidates the shell: a matching ETag gets 304', async () => {
    app = publicSPA()
    await app.ready()

    const first = await app.fetch('/settings', { headers: NAVIGATION })
    const etag = first.headers.get('etag')
    expect(etag).not.toBeNull()

    const second = await app.fetch('/settings', { headers: { ...NAVIGATION, 'if-none-match': etag! } })

    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')
  })
})
