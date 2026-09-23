import { JWTService, newRouter, type WebApplication } from '@caffeinejs/http'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

import { immutableAssets, spaMount, staticFiles } from '../../index.js'
import {
  clientRouteOf,
  CURL,
  dist,
  expectNotFoundJSON,
  IFRAME,
  isolated,
  NAVIGATION,
  notFound,
  shellOf,
  XHR,
} from './_headers.js'

const SECRET = 'jwt-hs256-secret-with-more-than-32-bytes-of-text'
const ISSUER = 'https://issuer.test'
const AUDIENCE = 'spa-api'

const signer = new JWTService({ secret: SECRET, issuer: ISSUER, audience: AUDIENCE, expiresIn: '5m' })

/**
 * A public single-page application whose API takes bearer tokens: the page is for everyone, every call it
 * makes carries a token, and a token is never redirected anywhere.
 */
function publicSPA(): WebApplication {
  return isolated()
    .authentication(a => a.addJWTBearer(j => j.secret(SECRET).issuer(ISSUER).audience(AUDIENCE)))
    .with(staticFiles(s => s.serve(dist, { ...spaMount(), setHeaders: immutableAssets(dist) }, { anonymous: true })))
    .mount(
      newRouter('/api')
        .authorize({})
        .get('/me', ctx => ({ sub: ctx.user.findFirst('sub')?.value }))
        .mount(
          newRouter('/admin')
            .authorize({ roles: ['admin'] })
            .get('/', () => ({ ok: true })),
        )
        .get('/*', notFound),
      newRouter()
        .detail('http', { internal: true })
        .authorize({ allowAnonymous: true })
        .get('/', shellOf(dist))
        .get('/index.html', shellOf(dist))
        .get('/*', clientRouteOf(dist)),
    ) as WebApplication
}

describe('public single-page application with a bearer-token API', () => {
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

    expect((await app.fetch('/api/admin', { headers: { ...XHR, authorization: admin } })).status).toBe(200)
  })

  // A bearer scheme has nowhere to redirect to, and the page must not step in for a URL the API owns.
  it('answers a navigation to a protected API route with 401, not the shell', async () => {
    app = publicSPA()
    await app.ready()

    expect((await app.fetch('/api/admin', { headers: NAVIGATION })).status).toBe(401)
  })

  // The one `/api/*` line keeps every miss under the API away from the page. It sits inside the authorized
  // group, so it carries that group's policy: an anonymous miss is challenged rather than answered, which is
  // the API's own posture and not the shell stepping in.
  it('keeps an API miss away from the page, for a navigation as much as for a fetch', async () => {
    app = publicSPA()
    await app.ready()

    await expectNotFoundJSON(await app.fetch('/api/typo', { headers: { ...XHR, authorization: user } }))
    await expectNotFoundJSON(await app.fetch('/api/typo', { headers: { ...NAVIGATION, authorization: user } }))

    const anonymous = await app.fetch('/api/typo', { headers: NAVIGATION })
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('content-type') ?? '').not.toMatch(/text\/html/)
  })

  it('answers a mistyped fetch of a client route with 404 rather than a page JavaScript cannot parse', async () => {
    app = publicSPA()
    await app.ready()

    await expectNotFoundJSON(await app.fetch('/settings', { headers: XHR }))
  })

  it('does not take a bare wildcard Accept for a document request', async () => {
    app = publicSPA()
    await app.ready()

    await expectNotFoundJSON(await app.fetch('/settings', { headers: CURL }))
  })

  // A declared path is a request for the document itself, so it answers a client that is not a browser.
  it('answers the declared paths to any client', async () => {
    app = publicSPA()
    await app.ready()

    expect((await app.fetch('/', { headers: CURL })).status).toBe(200)
    expect((await app.fetch('/index.html', { headers: CURL })).status).toBe(200)
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

  it('caches a hashed asset indefinitely and keeps a missing one a 404', async () => {
    app = publicSPA()
    await app.ready()

    const asset = await app.fetch('/assets/app-eZr2sdaR.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')

    await expectNotFoundJSON(await app.fetch('/assets/app-deadbeef.js', { headers: NAVIGATION }))
  })
})
