import { readFileSync } from 'node:fs'
import { connect, type ClientHttp2Session } from 'node:http2'
import { get as httpsGet } from 'node:https'

import { CaffeineIoC, Scopes, token } from '@caffeinejs/di'
import { newConfiguration } from '@caffeinejs/std'
import { InlineConfigSource, type InferConfig } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'
import { ErrShutdownTimeout } from '@caffeinejs/std/shutdown'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication, newRouter, type NodeMiddleware, type WebApplication } from '../index.js'

/**
 * A server `.server(...)` asks to serve TLS or HTTP/2 serves it, says so in its origin, and shuts down — within the
 * budget or cut when it runs out.
 *
 * Every client trusts the fixture through `ca` rather than skipping verification, so a response also proves the
 * server presented the certificate it was configured with.
 */

const key = readFileSync(new URL('./_testdata/tls/localhost.key', import.meta.url))
const cert = readFileSync(new URL('./_testdata/tls/localhost.crt', import.meta.url))

const listener = { host: '127.0.0.1', port: 0 }

/** What the handler saw, so a test reads the server's side of the exchange from the response. */
const echo = newRouter().get('/echo', ctx => ({
  protocol: ctx.platform.request.protocol,
  httpVersion: ctx.req.raw.httpVersion,
  url: ctx.req.url,
}))

interface Received {
  status: number
  body: unknown
}

/** One HTTP/1.1 request over TLS. */
function getHTTPS(url: string): Promise<Received> {
  return new Promise((resolve, reject) => {
    httpsGet(url, { ca: cert, agent: false }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => (data += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }))
    }).on('error', reject)
  })
}

/**
 * One HTTP/2 request on `session`, which stays open for the caller to close. Rejects when the stream closes with no
 * response, which is what a stream cut by the server sees.
 */
function getH2(session: ClientHttp2Session, path: string): Promise<Received> {
  return new Promise((resolve, reject) => {
    const req = session.request({ ':path': path })
    let status: number | undefined
    let data = ''
    req.setEncoding('utf8')
    req.on('response', headers => (status = Number(headers[':status'])))
    req.on('data', chunk => (data += chunk))
    req.on('end', () => {
      if (status !== undefined) {
        resolve({ status, body: JSON.parse(data) })
      }
    })
    req.on('close', () => reject(new Error(`The stream to "${path}" closed with no response`)))
    req.on('error', reject)
    req.end()
  })
}

function connectH2(origin: string): ClientHttp2Session {
  return connect(origin, { ca: cert })
}

/** A route whose handler holds until the test releases it, so a request is in flight when the server closes. */
function holding() {
  let started!: () => void
  let release!: () => void
  const inFlight = new Promise<void>(resolve => (started = resolve))
  const held = new Promise<void>(resolve => (release = resolve))

  const router = newRouter().get('/slow', async () => {
    started()
    await held
    return { ok: true }
  })

  return { router, inFlight, release }
}

describe('a server serving TLS or HTTP/2', () => {
  let app: WebApplication | undefined
  const sessions: ClientHttp2Session[] = []

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      session.destroy()
    }

    if (app !== undefined) {
      await app.close().catch(() => undefined)
      app = undefined
    }
  })

  function session(origin: string): ClientHttp2Session {
    const s = connectH2(origin)
    sessions.push(s)
    return s
  }

  describe('HTTPS', () => {
    it('serves over TLS and reports an https origin', async () => {
      app = createWebApplication()
        .server(() => ({ factory: { https: { key, cert } }, listener }))
        .mount(echo) as WebApplication

      const info = await app.run()

      expect(info.address?.origin).toBe(`https://127.0.0.1:${info.address?.port}`)
      // What a redirect or a `Secure` cookie decision reads off the request.
      expect(await getHTTPS(`${info.address!.origin}/echo`)).toEqual({
        status: 200,
        body: { protocol: 'https', httpVersion: '1.1', url: '/echo' },
      })
    })

    it('takes the key and certificate from the application configuration', async () => {
      const schema = $t.Object({
        tls: $t.Object({ key: $t.String(), cert: $t.String() }),
      })
      const conf = newConfiguration(schema, token<InferConfig<typeof schema>>(Symbol('https.config')))
        .source(new InlineConfigSource({ tls: { key: key.toString(), cert: cert.toString() } }))
        .build()

      app = createWebApplication({ config: conf })
        .server(({ config }) => ({ factory: { https: { key: config.tls.key, cert: config.tls.cert } }, listener }))
        .mount(echo) as WebApplication

      await app.run()

      expect((await getHTTPS(`${app.address!.origin}/echo`)).status).toBe(200)
    })

    it('renders a wildcard bind as a dialable https loopback origin', async () => {
      app = createWebApplication().server(() => ({
        factory: { https: { key, cert } },
        listener: { host: '0.0.0.0', port: 0 },
      }))

      const info = await app.run()

      expect(info.address?.origin).toBe(`https://127.0.0.1:${info.address?.port}`)
    })

    it('forces connections shut when an in-flight request overruns the shutdown budget', async () => {
      const { router, inFlight, release } = holding()
      app = createWebApplication()
        .server(() => ({ factory: { https: { key, cert } }, listener }))
        .shutdown(s => s.drainDelay(0).shutdownTimeout(200))
        .mount(router) as WebApplication

      await app.run()
      const request = getHTTPS(`${app.address!.origin}/slow`).catch((error: unknown) => error)
      await inFlight

      const error = await app.close().catch((error: unknown) => error)

      expect((error as AggregateError).errors[0]).toBeInstanceOf(ErrShutdownTimeout)
      expect(app.instance.server.listening).toBe(false)
      expect(await request).toBeInstanceOf(Error)

      release()
      app = undefined
    })
  })

  describe('HTTP/2', () => {
    it('serves HTTP/2 over TLS and reports an https origin', async () => {
      app = createWebApplication()
        .server(() => ({ factory: { http2: true, https: { key, cert } }, listener }))
        .mount(echo) as WebApplication

      await app.run()

      expect(app.address?.origin).toBe(`https://127.0.0.1:${app.address?.port}`)
      expect(await getH2(session(app.address!.origin), '/echo')).toEqual({
        status: 200,
        body: { protocol: 'https', httpVersion: '2.0', url: '/echo' },
      })
    })

    it('serves HTTP/1.1 clients too when the TLS options allow them', async () => {
      app = createWebApplication()
        .server(() => ({ factory: { http2: true, https: { key, cert, allowHTTP1: true } }, listener }))
        .mount(echo) as WebApplication

      await app.run()
      const origin = app.address!.origin

      expect((await getH2(session(origin), '/echo')).body).toMatchObject({ httpVersion: '2.0' })
      expect((await getHTTPS(`${origin}/echo`)).body).toMatchObject({ httpVersion: '1.1' })
    })

    it('serves cleartext HTTP/2 and reports an http origin', async () => {
      app = createWebApplication()
        .server(() => ({ factory: { http2: true }, listener }))
        .mount(echo) as WebApplication

      await app.run()

      expect(app.address?.origin).toBe(`http://127.0.0.1:${app.address?.port}`)
      expect(await getH2(session(app.address!.origin), '/echo')).toEqual({
        status: 200,
        body: { protocol: 'http', httpVersion: '2.0', url: '/echo' },
      })
    })

    // The base path is taken off by rewriting `url` on the raw request, and the middleware engine rewrites it per
    // layer: both run on Node's HTTP/2 compatibility request here, not on an `IncomingMessage`.
    it('routes under the base path and runs path middleware on HTTP/2 requests', async () => {
      const seen: string[] = []

      app = createWebApplication()
        .server(() => ({ factory: { http2: true, https: { key, cert } }, listener }))
        .basePath('/api')
        .mount(echo) as WebApplication
      app.use('/echo', ((req, _res, next) => {
        seen.push(req.url!)
        next()
      }) as NodeMiddleware)

      await app.run()

      expect(await getH2(session(app.address!.origin), '/api/echo')).toMatchObject({
        status: 200,
        body: { url: '/echo' },
      })
      expect(seen).toEqual(['/'])
    })

    // The scope ends on the raw response's `close`, which is Node's HTTP/2 compatibility response here. A scope that
    // never saw it would never destroy what the request resolved.
    it('destroys what a request scope resolved once the stream closes', async () => {
      let destroyed!: (id: number) => void
      const teardown = new Promise<number>(resolve => (destroyed = resolve))
      let created = 0

      class Session {
        readonly id = ++created
      }

      const container = new CaffeineIoC()
      container.bind(Session, t =>
        t
          .toSelf()
          .lifetime(Scopes.REQUEST)
          .preDestroy(s => destroyed(s.id)),
      )

      const router = newRouter()
        .get('/session')
        .inject(i => ({ session: i.provide(Session) }))
        .handler((_ctx, deps) => ({ id: deps.session.get().id }))

      app = createWebApplication({ container })
        .server(() => ({ factory: { http2: true, https: { key, cert } }, listener }))
        .mount(router) as WebApplication

      await app.run()

      expect((await getH2(session(app.address!.origin), '/session')).body).toEqual({ id: 1 })
      expect(await teardown).toBe(1)
    })

    it('closes promptly with an idle session still open', async () => {
      app = createWebApplication()
        .server(() => ({ factory: { http2: true, https: { key, cert } }, listener }))
        .mount(echo) as WebApplication

      await app.run()
      const client = session(app.address!.origin)
      await getH2(client, '/echo')

      const startedAt = Date.now()
      await app.close()
      app = undefined

      expect(Date.now() - startedAt).toBeLessThan(1_000)
    })

    // An HTTP/2 server has no `closeAllConnections()`: calling it anyway failed the forced teardown with a
    // `TypeError` and left the stream open.
    it('forces sessions shut when an in-flight stream overruns the shutdown budget', async () => {
      const { router, inFlight, release } = holding()
      app = createWebApplication()
        .server(() => ({ factory: { http2: true, https: { key, cert } }, listener }))
        .shutdown(s => s.drainDelay(0).shutdownTimeout(200))
        .mount(router) as WebApplication

      await app.run()
      const request = getH2(session(app.address!.origin), '/slow').catch((error: unknown) => error)
      await inFlight

      const error = await app.close().catch((error: unknown) => error)

      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toHaveLength(1)
      expect((error as AggregateError).errors[0]).toBeInstanceOf(ErrShutdownTimeout)
      expect(app.instance.server.listening).toBe(false)
      expect(await request).toBeInstanceOf(Error)

      release()
      app = undefined
    })
  })
})
