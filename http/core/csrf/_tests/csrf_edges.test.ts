import { readFileSync } from 'node:fs'
import { connect as connectHTTP2 } from 'node:http2'
import { connect } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../../application.js'
import { bindTo, csrfExempt, type OriginPredicate, type WebApplication, Router } from '../../../index.js'
import { node } from '../../../platform/node.testkit.js'
import { corsPolicy } from '../../cors/cors.js'
import { csrf } from '../csrf.js'

/**
 * `csrf()` where a reviewer probes it: header shapes no browser sends, methods outside the safe set, the spellings a
 * router accepts, international names, HTTP/2, proxies, CORS, and several plugins at once.
 */

/** A form on another site posting here. */
const CROSS_SITE: Record<string, string> = {
  origin: 'https://evil.example',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
}

const listener = { host: '127.0.0.1', port: 0 }

const key = readFileSync(new URL('../../../_tests/_testdata/tls/localhost.key', import.meta.url))
const cert = readFileSync(new URL('../../../_tests/_testdata/tls/localhost.crt', import.meta.url))

const ok = () => ({ ok: true })

/** `POST /echo`. */
const echo = () => new Router('/echo').post('/', ok)

interface Requesting {
  request(url: string, init?: RequestInit): Promise<Response>
}

function post(app: Requesting, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(path, { method: 'POST', headers })
}

/** Posts to `/echo` over a socket, headers as written: `fetch` would fold a header sent twice into one. */
function rawPost(port: number, headers: ReadonlyArray<readonly [string, string]>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = headers.map(([name, value]) => `${name}: ${value}\r\n`).join('')
      socket.end(`POST /echo HTTP/1.1\r\nHost: localhost\r\n${lines}Content-Length: 0\r\nConnection: close\r\n\r\n`)
    })
    let response = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      response += chunk
    })
    socket.on('end', () => resolve(Number(response.slice(9, 12))))
    socket.on('error', reject)
  })
}

/** Posts to `/echo` over HTTP/2, where the host is `:authority` and the scheme is the TLS socket's. */
async function postHTTP2(origin: string, headers: Record<string, string>): Promise<number> {
  const session = connectHTTP2(origin, { ca: cert })

  try {
    return await new Promise<number>((resolve, reject) => {
      let status = 0
      const request = session.request({ ':method': 'POST', ':path': '/echo', ...headers })
      request.on('response', response => {
        status = Number(response[':status'])
      })
      request.on('end', () => resolve(status))
      request.on('error', reject)
      request.resume()
      request.end()
    })
  } finally {
    session.close()
  }
}

describe('csrf() at the edges', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  async function ready<A extends { bootstrap(): Promise<unknown>; close(): Promise<unknown> }>(app: A): Promise<A> {
    close = () => app.close()
    await app.bootstrap()
    return app
  }

  async function running<A extends { run(): Promise<unknown>; close(): Promise<unknown> }>(app: A): Promise<A> {
    close = () => app.close()
    await app.run()
    return app
  }

  describe('header shapes', () => {
    // No browser sends either header twice. Node folds a repeated header into one value, which no browser writes
    // either: the check reads it as it is, and refuses it.
    it('refuses a Sec-Fetch-Site or an Origin sent twice', async () => {
      const app = (await running(
        createWebApplication({ adapter: node() })
          .server(() => ({ listen: listener }))
          .with(csrf())
          .mount(echo()),
      )) as WebApplication
      const port = app.address!.port

      expect(await rawPost(port, [['Origin', 'http://localhost']])).toBe(200)
      expect(
        await rawPost(port, [
          ['Sec-Fetch-Site', 'same-origin'],
          ['Sec-Fetch-Site', 'same-origin'],
        ]),
      ).toBe(403)
      expect(
        await rawPost(port, [
          ['Origin', 'http://localhost'],
          ['Origin', 'http://localhost'],
        ]),
      ).toBe(403)
    })

    it('refuses Sec-Fetch-Site from another site when the Origin is missing, and asks no check', async () => {
      const asked: string[] = []
      const app = await ready(
        createWebApplication({ adapter: node() })
          .with(csrf(c => c.allowSecFetchSite((_ctx, site) => asked.push(site) > 0)))
          .mount(echo()),
      )

      expect((await post(app, '/echo', { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
      expect((await post(app, '/echo', { 'sec-fetch-site': 'same-site' })).status).toBe(403)
      expect(asked).toEqual([])
    })

    // `none` is a navigation the user started: the browser's word decides, whatever the Origin says.
    it('lets Sec-Fetch-Site: none through, whatever the Origin says', async () => {
      const app = await ready(createWebApplication({ adapter: node() }).with(csrf()).mount(echo()))

      expect((await post(app, '/echo', { 'sec-fetch-site': 'none', origin: 'https://evil.example' })).status).toBe(200)
    })
  })

  describe('methods', () => {
    // `QUERY` is safe, like `GET`, even with a body: a cross-site one is a read.
    it('never refuses a QUERY', async () => {
      const app = await ready(
        createWebApplication({ adapter: node() }).with(csrf()).mount(new Router('/search').query('/', ok)),
      )
      const res = await app.request('/search', {
        method: 'QUERY',
        headers: { ...CROSS_SITE, 'content-type': 'application/json' },
        body: '{"q":"x"}',
      })

      expect(res.status).toBe(200)
    })
  })

  describe('router spellings', () => {
    // Whatever spelling the router accepts reaches a route with that route's protection, and borrows no other's.
    it('protects every spelling of a route the router accepts, and exempts no other route', async () => {
      const ran: string[] = []
      const app = await ready(
        createWebApplication({ adapter: node() })
          .server(() => ({
            router: { ignoreTrailingSlash: true, caseSensitive: false, ignoreDuplicateSlashes: true },
          }))
          .with(csrf(c => c.exclude('/webhooks')))
          .mount(
            new Router('/echo').post('/', () => (ran.push('echo'), ok())),
            new Router('/webhooks').post('/:id', () => (ran.push('webhook'), ok())),
          ),
      )

      for (const path of ['/echo/', '/ECHO', '//echo', '/%65cho']) {
        expect((await post(app, path, CROSS_SITE)).status, path).toBe(403)
      }
      expect((await post(app, '/WEBHOOKS/x', CROSS_SITE)).status).toBe(200)
      expect((await post(app, '/webhooks/..%2Fecho', CROSS_SITE)).status).toBe(200)
      expect(ran).toEqual(['webhook', 'webhook'])
    })

    it('reads an exclusion written with a trailing slash as the same prefix', async () => {
      const app = await ready(
        createWebApplication({ adapter: node() })
          .with(csrf(c => c.exclude('/webhooks/')))
          .mount(new Router('/webhooks').post('/', ok).post('/:id', ok), new Router('/webhooksx').post('/', ok)),
      )

      expect((await post(app, '/webhooks', CROSS_SITE)).status).toBe(200)
      expect((await post(app, '/webhooks/1', CROSS_SITE)).status).toBe(200)
      expect((await post(app, '/webhooksx', CROSS_SITE)).status).toBe(403)
    })
  })

  describe('international names', () => {
    // A browser sends a Unicode host in punycode, and the list is spelled the same way, so either spelling trusts it.
    it('trusts an international origin by the punycode a browser sends, and hands a check the same', async () => {
      const seen: string[] = []
      const record: OriginPredicate = (_ctx, { hostname }) => seen.push(hostname) < 0
      const app = await ready(
        createWebApplication({ adapter: node() })
          .with(csrf(c => c.trustedOrigins('https://bücher.example').trustOrigin(record)))
          .mount(echo()),
      )

      expect((await post(app, '/echo', { ...CROSS_SITE, origin: 'https://xn--bcher-kva.example' })).status).toBe(200)
      expect((await post(app, '/echo', { ...CROSS_SITE, origin: 'https://xn--mnchen-3ya.example' })).status).toBe(403)
      expect(seen).toEqual(['xn--mnchen-3ya.example'])
    })
  })

  describe('over HTTP/2', () => {
    // The host is `:authority` and the scheme is the TLS socket's: no Host header and no proxy to read.
    it('compares the Origin with :authority, and refuses the same host over plain HTTP', async () => {
      const app = (await running(
        createWebApplication({ adapter: node() })
          .server(() => ({ http2: true, https: { key, cert }, listen: listener }))
          .with(csrf())
          .mount(echo()),
      )) as WebApplication
      const origin = app.address!.origin
      const port = app.address!.port

      expect(await postHTTP2(origin, { origin })).toBe(200)
      expect(await postHTTP2(origin, { origin: `http://127.0.0.1:${port}` })).toBe(403)
      expect(await postHTTP2(origin, { origin: 'https://evil.example' })).toBe(403)
    })
  })

  describe('behind a proxy', () => {
    const proxied = {
      origin: 'https://proxied.example',
      'x-forwarded-host': 'proxied.example',
      'x-forwarded-proto': 'https',
    }
    const downgrade = { origin: 'http://localhost', 'x-forwarded-proto': 'https' }

    it('follows the forwarding headers of a proxy trusted by address', async () => {
      const app = await ready(
        createWebApplication({ adapter: node() })
          .server(() => ({ trustProxy: '127.0.0.1' }))
          .with(csrf())
          .mount(echo()),
      )

      expect((await post(app, '/echo', proxied)).status).toBe(200)
      expect((await post(app, '/echo', downgrade)).status).toBe(403)
    })

    // A proxy appends what it saw: a client's own entry ahead of it does not count, and `Forwarded` is not read.
    it('reads the last X-Forwarded-Proto entry, and never Forwarded', async () => {
      const app = await ready(
        createWebApplication({ adapter: node() })
          .server(() => ({ trustProxy: true }))
          .with(csrf())
          .mount(echo()),
      )

      expect(
        (await post(app, '/echo', { origin: 'http://localhost', 'x-forwarded-proto': 'https, http' })).status,
      ).toBe(200)
      expect(
        (await post(app, '/echo', { origin: 'http://localhost', 'x-forwarded-proto': 'http, https' })).status,
      ).toBe(403)
      expect(
        (await post(app, '/echo', { origin: 'https://proxied.example', forwarded: 'host=proxied.example;proto=https' }))
          .status,
      ).toBe(403)
    })
  })

  describe('the scheme', () => {
    // Behind a proxy that ended TLS and is not trusted, the server sees `http` while the page was `https`. Only this
    // same host's HTTPS side can send that Origin, so the host decides, as Go and NestJS have it.
    it('lets an https Origin naming this host through on a request seen as http, with no Fetch Metadata', async () => {
      const app = await ready(createWebApplication({ adapter: node() }).with(csrf()).mount(echo()))

      expect((await post(app, '/echo', { origin: 'https://localhost' })).status).toBe(200)
    })

    // What a browser sends when an https page posts a form to an http URL, under its default referrer policy.
    it('refuses Origin: null, what a browser sends for a form posted from https to http', async () => {
      const app = await ready(createWebApplication({ adapter: node() }).with(csrf()).mount(echo()))

      expect((await post(app, '/echo', { origin: 'null', 'sec-fetch-mode': 'navigate' })).status).toBe(403)
    })
  })

  describe('with CORS', () => {
    const fromFront = { origin: 'https://front.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }
    const cors = corsPolicy(c => void c.origins('https://front.example').credentials(true))

    // An origin CORS allows is not trusted here. CORS writes its headers as the answer goes out, so the front end reads
    // the 403 whichever of the two was registered first.
    it.each([
      ['CORS ahead', true],
      ['CORS behind', false],
    ])('carries the CORS headers on a refusal, with %s', async (_order, corsFirst) => {
      const app = await ready(
        corsFirst
          ? createWebApplication({ adapter: node() }).with(cors).with(csrf()).mount(echo())
          : createWebApplication({ adapter: node() }).with(csrf()).with(cors).mount(echo()),
      )
      const refused = await post(app, '/echo', fromFront)

      expect(refused.status).toBe(403)
      expect(refused.headers.get('access-control-allow-origin')).toBe('https://front.example')
    })

    it('never refuses a preflight', async () => {
      const app = await ready(createWebApplication({ adapter: node() }).with(cors).with(csrf()).mount(echo()))
      const res = await app.request('/echo', {
        method: 'OPTIONS',
        headers: { ...fromFront, 'access-control-request-method': 'POST' },
      })

      expect(res.status).toBe(204)
    })
  })

  describe('several plugins', () => {
    // An exclusion belongs to the plugin it was given to. A route's own mark speaks to every plugin.
    it("keeps the root plugin's check on a path a route group's own plugin excludes", async () => {
      const admin = new Router('/admin')
        .with(csrf(c => c.name('admin').exclude('/admin/hooks')))
        .post('/hooks', ok)
        .post('/marked')
        .extend(csrfExempt())
        .handler(ok)

      const app = await ready(createWebApplication({ adapter: node() }).with(csrf()).mount(admin))

      expect((await post(app, '/admin/hooks', CROSS_SITE)).status).toBe(403)
      expect((await post(app, '/admin/marked', CROSS_SITE)).status).toBe(200)
    })

    it("leaves the application server's paths to its own plugin, whatever a listener excludes", async () => {
      const app = (await running(
        createWebApplication({ adapter: node() })
          .listener('admin', l => l.server(() => ({ listen: listener })).with(csrf(c => c.exclude('/hooks'))))
          .server(() => ({ listen: listener }))
          .with(csrf())
          .mount(new Router('/hooks').extend(bindTo('admin')).post('/', ok), new Router('/hooks').post('/', ok)),
      )) as WebApplication
      const admin = app.listeners.get('admin')!.address!.origin

      expect((await fetch(`${admin}/hooks`, { method: 'POST', headers: CROSS_SITE })).status).toBe(200)
      expect((await fetch(`${app.address!.origin}/hooks`, { method: 'POST', headers: CROSS_SITE })).status).toBe(403)
    })
  })
})
