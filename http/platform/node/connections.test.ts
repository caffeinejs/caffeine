import { readFileSync } from 'node:fs'
import { connect as http2Connect, type ClientHttp2Session } from 'node:http2'
import { connect as netConnect, type Server as NetServer, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'

import { newNoopLogger } from '@caffeinejs/application/logger'
import { ErrShutdownTimeout } from '@caffeinejs/application/shutdown'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWebApplication, type WebApplication } from '../../application.js'
import { Router, type AnyRouter } from '../../index.js'
import { node, type NodeAdapter } from './node.js'

const key = readFileSync(new URL('../../_tests/_testdata/tls/localhost.key', import.meta.url))
const cert = readFileSync(new URL('../../_tests/_testdata/tls/localhost.crt', import.meta.url))

type App = WebApplication<never, never, unknown, NodeAdapter>

let open: App | undefined

afterEach(async () => {
  // A close a failed test left waiting on a fake timer is let go first; then the clock is restored before anything
  // closes, since a fake clock never fires the close's own timers.
  if (vi.isFakeTimers()) {
    await vi.runOnlyPendingTimersAsync()
  }
  vi.useRealTimers()
  await open?.close().catch(() => undefined)
  open = undefined
})

/** A route answering at once, and one whose handler holds until the test releases it. */
function routes() {
  const inFlight = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const router = new Router('/drain')
  router.get('/fast').handler(() => ({ ok: true }))
  router.get('/slow').handler(async () => {
    inFlight.resolve()
    await release.promise
    return { ok: true }
  })
  return { router, inFlight, release }
}

async function start(router: AnyRouter, settings: object = {}, budget = 5 * Second) {
  const app = createWebApplication({ adapter: node() })
    .logger(b => b.use(newNoopLogger()))
    .server(() => settings as never)
    .shutdown(s => s.drainDelay(0).shutdownTimeout(budget))
    .mount(router)
  open = app
  const { address } = await app.run({ host: '127.0.0.1', port: 0 })
  return { app, port: address.port, origin: address.origin }
}

/** A client connection that has sent nothing, once the server has accepted it. */
async function silentConnection(app: App, port: number): Promise<Socket> {
  const accepted = new Promise(resolve => (app.instance as NetServer).once('connection', resolve))
  const socket = netConnect(port, '127.0.0.1')
  socket.on('error', () => undefined)
  await accepted
  return socket
}

/** Reads what arrives on `socket` until `done` says it is all there. */
function reading(socket: Socket | TLSSocket, done: (received: string) => boolean): Promise<string> {
  socket.setEncoding('utf8')
  return new Promise(resolve => {
    let received = ''
    socket.on('data', (chunk: string) => {
      received += chunk
      if (done(received)) {
        resolve(received)
      }
    })
    socket.on('close', () => resolve(received))
  })
}

function h2(path: string, session: ClientHttp2Session): Promise<number> {
  return new Promise((resolve, reject) => {
    const stream = session.request({ ':path': path })
    let status = 0
    stream.on('response', headers => (status = Number(headers[':status'])))
    stream.on('data', () => undefined)
    stream.on('end', () => resolve(status))
    stream.on('error', reject)
    stream.end()
  })
}

describe('closing the Node application', () => {
  // Re-pins `_tests/graceful_shutdown.test.ts`.
  it('closes a connection that never sent a request instead of waiting out the budget', async () => {
    const { app, port } = await start(routes().router)
    const client = await silentConnection(app, port)
    const hungUp = new Promise(resolve => client.once('close', resolve))

    await expect(app.close()).resolves.toBeUndefined()
    await hungUp
  })

  // Re-pins `_tests/graceful_shutdown.test.ts`.
  it('lets a request in flight finish, then closes the connection it kept alive', async () => {
    const { router, inFlight, release } = routes()
    const { app, port } = await start(router)

    const idle = netConnect(port, '127.0.0.1')
    idle.on('error', () => undefined)
    const answered = reading(idle, received => received.endsWith('{"ok":true}'))
    idle.write('GET /drain/fast HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
    await answered

    const request = fetch(`http://127.0.0.1:${port}/drain/slow`)
    await inFlight.promise
    idle.once('close', release.resolve)
    const closed = app.close()

    const response = await request
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    await expect(closed).resolves.toBeUndefined()
  })

  // Re-pins `_tests/graceful_shutdown.test.ts`.
  it('forces connections shut and reports a timeout when a request in flight overruns the budget', async () => {
    const { router, inFlight, release } = routes()
    const { app, port } = await start(router, {}, 30 * Second)

    const request = fetch(`http://127.0.0.1:${port}/drain/slow`).catch(() => undefined)
    await inFlight.promise

    // The budget's clock is driven; the close's own `setImmediate` stays real, so each step yields a real tick.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let error: unknown
    let settled = false
    void app.close().then(
      () => (settled = true),
      (err: unknown) => {
        error = err
        settled = true
      },
    )
    while (!settled) {
      await vi.advanceTimersByTimeAsync(1 * Second)
      await new Promise(resolve => setImmediate(resolve))
    }
    vi.useRealTimers()

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[0]).toBeInstanceOf(ErrShutdownTimeout)
    expect((app.instance as NetServer).listening).toBe(false)

    release.resolve()
    await request
  })

  // Re-pins `_tests/https.test.ts`: a browser's TLS preconnect.
  it('closes a TLS connection that completed its handshake and never sent a request', async () => {
    const { app, port } = await start(routes().router, { https: { key, cert } })
    const secured = new Promise(resolve => (app.instance as NetServer).once('secureConnection', resolve))
    const client = tlsConnect({ host: '127.0.0.1', port, ca: cert, servername: 'localhost' })
    client.on('error', () => undefined)
    const hungUp = new Promise(resolve => client.once('close', resolve))
    await secured

    await expect(app.close()).resolves.toBeUndefined()
    await hungUp
  })

  // Re-pins `_tests/https.test.ts`.
  it('closes an HTTP/1.1 connection that never sent a request on an allowHTTP1 server', async () => {
    const { app, port } = await start(routes().router, { https: { key, cert }, http2: { allowHTTP1: true } })
    const secured = new Promise(resolve => (app.instance as NetServer).once('secureConnection', resolve))
    const client = tlsConnect({
      host: '127.0.0.1',
      port,
      ca: cert,
      servername: 'localhost',
      ALPNProtocols: ['http/1.1'],
    })
    client.on('error', () => undefined)
    const hungUp = new Promise(resolve => client.once('close', resolve))
    await secured

    await expect(app.close()).resolves.toBeUndefined()
    await hungUp
  })

  // Re-pins `_tests/https.test.ts`.
  it('lets an HTTP/1.1 request in flight finish on an allowHTTP1 server, then closes the connection it kept alive', async () => {
    const { router, inFlight, release } = routes()
    const { app, port } = await start(router, { https: { key, cert }, http2: { allowHTTP1: true } })

    const keptAlive = (path: string) => {
      const socket = tlsConnect({
        host: '127.0.0.1',
        port,
        ca: cert,
        servername: 'localhost',
        ALPNProtocols: ['http/1.1'],
      })
      socket.on('error', () => undefined)
      const answered = reading(socket, received => received.endsWith('{"ok":true}'))
      socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`)
      return { socket, answered }
    }

    const idle = keptAlive('/drain/fast')
    expect(await idle.answered).toMatch(/^HTTP\/1\.1 200 /)
    const slow = keptAlive('/drain/slow')
    await inFlight.promise

    idle.socket.once('close', release.resolve)
    const closed = app.close()

    expect(await slow.answered).toMatch(/^HTTP\/1\.1 200 /)
    await expect(closed).resolves.toBeUndefined()
  })

  // Re-pins `_tests/https.test.ts`: within the budget, or `close()` rejects with the timeout.
  it('closes within the budget with an idle HTTP/2 session still open', async () => {
    const { app, origin } = await start(routes().router, { https: { key, cert }, http2: true })
    const session = http2Connect(origin, { ca: cert, servername: 'localhost' })
    session.on('error', () => undefined)
    expect(await h2('/drain/fast', session)).toBe(200)

    await expect(app.close()).resolves.toBeUndefined()
    session.close()
  })

  // Re-pins `_tests/https.test.ts`.
  it('lets an HTTP/2 stream in flight finish while the server closes', async () => {
    const { router, inFlight, release } = routes()
    const { app, origin } = await start(router, { https: { key, cert }, http2: true })
    const session = http2Connect(origin, { ca: cert, servername: 'localhost' })
    session.on('error', () => undefined)

    const request = h2('/drain/slow', session)
    await inFlight.promise
    const goaway = new Promise(resolve => session.once('goaway', resolve))

    const closed = app.close()
    await goaway
    release.resolve()

    expect(await request).toBe(200)
    await expect(closed).resolves.toBeUndefined()
    session.close()
  })
})
