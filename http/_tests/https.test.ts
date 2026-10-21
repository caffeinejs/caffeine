import { readFileSync } from 'node:fs'
import { connect, type ClientHttp2Session } from 'node:http2'
import { get as httpsGet } from 'node:https'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'

import { newConfiguration } from '@caffeinejs/application'
import type { InferConfig } from '@caffeinejs/application/config'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { $t } from '@caffeinejs/application/schema'
import { ErrShutdownTimeout } from '@caffeinejs/application/shutdown'
import { CaffeineIoC, Scopes } from '@caffeinejs/di'
import { Second } from '@caffeinejs/std/duration'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import { type NodeMiddleware, type WebApplication } from '../index.js'
import { createWebApplication, newRouter } from '../platform/fastify/index.js'

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

/**
 * One HTTP/1.1 request over a TLS connection of its own, kept alive for the caller. `status` resolves once the whole
 * body has arrived, and rejects when the connection closes with no response.
 */
function keptAlive(origin: string, path: string): { socket: TLSSocket; status: Promise<number> } {
  const { hostname, port } = new URL(origin)
  const socket = tlsConnect({ host: hostname, port: Number(port), ca: cert, ALPNProtocols: ['http/1.1'] })
  socket.on('error', () => undefined)
  socket.setEncoding('utf8')

  const status = new Promise<number>((resolve, reject) => {
    let received = ''
    socket.on('data', (chunk: string) => {
      received += chunk
      const head = received.indexOf('\r\n\r\n')
      const length = /\r\ncontent-length: (\d+)/i.exec(received)
      if (head !== -1 && length !== null && received.length - head - 4 >= Number(length[1])) {
        resolve(Number(received.slice('HTTP/1.1 '.length, 'HTTP/1.1 '.length + 3)))
      }
    })
    socket.on('close', () => reject(new Error(`The connection to "${path}" closed with no response`)))
  })
  socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`)

  return { socket, status }
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

/** A plugin whose `preClose` hook holds the close until `resume()`: the server still listens while it does. */
function holdingClose() {
  let closing!: () => void
  let resume!: () => void
  const preClose = new Promise<void>(resolve => (closing = resolve))
  const held = new Promise<void>(resolve => (resume = resolve))

  const plugin = () =>
    fp(async (instance: FastifyInstance) => {
      instance.addHook('preClose', async () => {
        closing()
        await held
      })
    })

  return { plugin, preClose, resume }
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
      const conf = newConfiguration(schema)
        .source(new InlineConfigSource({ tls: { key: key.toString(), cert: cert.toString() } }))
        .build().config

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

    // A browser's TLS preconnect: the handshake completes, and no request follows.
    it('closes a connection that completed its handshake and never sent a request', async () => {
      app = createWebApplication()
        .server(() => ({ factory: { https: { key, cert } }, listener }))
        .shutdown(s => s.drainDelay(0).shutdownTimeout(5 * Second))
        .mount(echo) as WebApplication

      await app.run()
      const secured = new Promise(resolve => app!.instance.server.once('secureConnection', resolve))
      const client = tlsConnect({ host: '127.0.0.1', port: app.address!.port, ca: cert })
      client.on('error', () => undefined)
      const hungUp = new Promise(resolve => client.once('close', resolve))
      await secured

      await expect(app.close()).resolves.toBeUndefined()
      app = undefined
      await hungUp
    })

    // A load balancer's TCP check on an HTTPS port: the connection opens, and no handshake follows.
    it('closes a connection that never started its handshake', async () => {
      app = createWebApplication()
        .server(() => ({ factory: { https: { key, cert } }, listener }))
        .shutdown(s => s.drainDelay(0).shutdownTimeout(5 * Second))
        .mount(echo) as WebApplication

      await app.run()
      const accepted = new Promise(resolve => app!.instance.server.once('connection', resolve))
      const client = netConnect(app.address!.port, '127.0.0.1')
      client.on('error', () => undefined)
      const hungUp = new Promise(resolve => client.once('close', resolve))
      await accepted

      await expect(app.close()).resolves.toBeUndefined()
      app = undefined
      await hungUp
    })

    // A handshake that started carries no request either, but it may yet finish, so only the budget running out
    // ends it. Node's own timeout for it is two minutes.
    it('forces a stalled handshake shut when the shutdown budget runs out', async () => {
      app = createWebApplication()
        .server(() => ({ factory: { https: { key, cert } }, listener }))
        .shutdown(s => s.drainDelay(0).shutdownTimeout(200))
        .mount(echo) as WebApplication

      await app.run()
      const accepted = new Promise(resolve => app!.instance.server.once('connection', resolve))
      const client = netConnect(app.address!.port, '127.0.0.1')
      client.on('error', () => undefined)
      const hungUp = new Promise(resolve => client.once('close', resolve))
      await accepted
      // The start of a TLS record header, and nothing after it.
      client.write(Buffer.from([0x16, 0x03, 0x01]))

      const error = await app.close().catch((error: unknown) => error)
      app = undefined

      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors[0]).toBeInstanceOf(ErrShutdownTimeout)
      await hungUp
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

    // An HTTP/1.1 connection on an HTTP/2 server runs on Node's HTTP/1 server, which closes only idle connections.
    it('closes an HTTP/1.1 connection that never sent a request', async () => {
      app = createWebApplication()
        .server(() => ({ factory: { http2: true, https: { key, cert, allowHTTP1: true } }, listener }))
        .shutdown(s => s.drainDelay(0).shutdownTimeout(5 * Second))
        .mount(echo) as WebApplication

      await app.run()
      const secured = new Promise(resolve => app!.instance.server.once('secureConnection', resolve))
      const client = tlsConnect({ host: '127.0.0.1', port: app.address!.port, ca: cert, ALPNProtocols: ['http/1.1'] })
      client.on('error', () => undefined)
      const hungUp = new Promise(resolve => client.once('close', resolve))
      await secured

      await expect(app.close()).resolves.toBeUndefined()
      app = undefined
      await hungUp
    })

    it('lets an HTTP/1.1 request in flight finish, then closes the connection it kept alive', async () => {
      const { router, inFlight, release } = holding()
      app = createWebApplication()
        .server(() => ({ factory: { http2: true, https: { key, cert, allowHTTP1: true } }, listener }))
        .shutdown(s => s.drainDelay(0).shutdownTimeout(5 * Second))
        .mount(echo, router) as WebApplication

      await app.run()
      const origin = app.address!.origin
      const idle = keptAlive(origin, '/echo')
      expect(await idle.status).toBe(200)
      const slow = keptAlive(origin, '/slow')
      await inFlight

      // The server ends the idle connection as it stops accepting, so the request in flight finishes after that.
      idle.socket.once('close', release)
      const closed = app.close()

      expect(await slow.status).toBe(200)
      await expect(closed).resolves.toBeUndefined()
      app = undefined
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

    it('closes promptly with an idle cleartext session still open', async () => {
      app = createWebApplication()
        .server(() => ({ factory: { http2: true }, listener }))
        .mount(echo) as WebApplication

      await app.run()
      const client = session(app.address!.origin)
      await getH2(client, '/echo')

      const startedAt = Date.now()
      await app.close()
      app = undefined

      expect(Date.now() - startedAt).toBeLessThan(1_000)
    })

    // Closing a session refuses new streams but lets the open ones finish, so a client mid-request still gets its
    // answer from a server going down within the budget.
    it('lets a stream in flight finish while the server closes', async () => {
      const { router, inFlight, release } = holding()
      app = createWebApplication()
        .server(() => ({ factory: { http2: true, https: { key, cert } }, listener }))
        .mount(router) as WebApplication

      await app.run()
      const client = session(app.address!.origin)
      const request = getH2(client, '/slow')
      await inFlight
      const goaway = new Promise(resolve => client.once('goaway', resolve))

      const closed = app.close()
      await goaway
      release()

      expect(await request).toEqual({ status: 200, body: { ok: true } })
      await expect(closed).resolves.toBeUndefined()
      app = undefined
    })

    // The server listens until its `preClose` hooks have run, so a client can still connect once closing has begun.
    it('closes a session that opens while the server is closing', async () => {
      let closing!: () => void
      let resume!: () => void
      const preClose = new Promise<void>(resolve => (closing = resolve))
      const held = new Promise<void>(resolve => (resume = resolve))

      app = createWebApplication()
        .server(() => ({ factory: { http2: true, https: { key, cert } }, listener }))
        .with(() =>
          fp(async (instance: FastifyInstance) => {
            instance.addHook('preClose', async () => {
              closing()
              await held
            })
          }),
        )
        .mount(echo) as WebApplication

      await app.run()
      const origin = app.address!.origin

      const closed = app.close()
      await preClose
      const late = session(origin)
      // The server's settings arrive once it has taken the connection on as a session.
      await new Promise(resolve => late.once('remoteSettings', resolve))

      const startedAt = Date.now()
      resume()
      await expect(closed).resolves.toBeUndefined()
      app = undefined

      expect(Date.now() - startedAt).toBeLessThan(1_000)
    })

    // `session.close()` does not end a session that never read its preface, so a connection that opens while the
    // server is closing and stays silent held the close until the budget ran out.
    it.each([
      {
        connection: 'a cleartext connection that sends no preface',
        factory: { http2: true },
        accepted: 'connection',
        connect: (port: number) => netConnect(port, '127.0.0.1'),
      },
      {
        connection: 'a TLS connection that finishes its handshake and sends no preface',
        factory: { http2: true, https: { key, cert } },
        accepted: 'secureConnection',
        connect: (port: number) => tlsConnect({ host: '127.0.0.1', port, ca: cert, ALPNProtocols: ['h2'] }),
      },
      {
        connection: 'a TLS connection that never starts its handshake',
        factory: { http2: true, https: { key, cert } },
        accepted: 'connection',
        connect: (port: number) => netConnect(port, '127.0.0.1'),
      },
    ])('closes $connection, opened while the server is closing', async ({ factory, accepted, connect }) => {
      const { plugin, preClose, resume } = holdingClose()
      app = createWebApplication()
        .server(() => ({ factory, listener }))
        .shutdown(s => s.drainDelay(0).shutdownTimeout(5 * Second))
        .with(plugin)
        .mount(echo) as WebApplication

      await app.run()
      const port = app.address!.port

      const closed = app.close()
      await preClose
      const opened = new Promise(resolve => app!.instance.server.once(accepted, resolve))
      connect(port).on('error', () => undefined)
      await opened
      resume()

      await expect(closed).resolves.toBeUndefined()
      app = undefined
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
