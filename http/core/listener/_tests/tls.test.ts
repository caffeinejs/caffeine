import { connect, type ClientHttp2Session } from 'node:http2'
import { get as httpsGet } from 'node:https'

import { ErrShutdownTimeout } from '@caffeinejs/std/shutdown'
import { testTLS, testTLSCertificate } from '@caffeinejs/testing/tls'
import { afterEach, describe, expect, it } from 'vitest'

import { Listener, bindTo, type WebApplication } from '../../../index.js'
import { createWebApplication, newRouter } from '../../../platform/fastify/index.js'

/**
 * Scenario: a listener with TLS.
 *
 * TLS is a factory setting, so each server serves it or not on its own: a listener and the application's own
 * server never share their TLS settings. Every client trusts the test certificate through `ca` rather than skipping
 * verification, so a response also proves which server presented it.
 */

const listener = { host: '127.0.0.1', port: 0 }

/** What the handler saw: the protocol and the HTTP version it was served over. */
const echo = (path: string) =>
  newRouter(path).get('/', ctx => ({ protocol: ctx.platform.request.protocol, httpVersion: ctx.req.raw.httpVersion }))

interface Received {
  status: number
  body: unknown
}

/** One HTTP/1.1 request over TLS. */
function getHTTPS(url: string): Promise<Received> {
  return new Promise((resolve, reject) => {
    httpsGet(url, { ca: testTLSCertificate(), agent: false }, res => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', chunk => (data += chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data === '' ? undefined : JSON.parse(data) }))
    }).on('error', reject)
  })
}

/** One HTTP/2 request. Rejects when the stream closes with no response, which is what a stream cut by the server sees. */
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

describe('a listener with TLS', () => {
  let app: WebApplication | undefined
  const sessions: ClientHttp2Session[] = []

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      session.destroy()
    }

    await app?.close().catch(() => undefined)
    app = undefined
  })

  function session(origin: string): ClientHttp2Session {
    const s = connect(origin, { ca: testTLSCertificate() })
    sessions.push(s)
    return s
  }

  it('serves HTTPS on the listener while the application server stays plain HTTP', async () => {
    app = createWebApplication()
      .install(Listener('admin', l => l.server(() => ({ factory: { https: testTLS() }, listener }))))
      .server(() => ({ listener }))
      .mount(echo('/ops').extend(bindTo('admin')), echo('/api')) as WebApplication

    await app.run()

    const admin = app.listeners.get('admin')!.address!
    expect(admin.origin).toBe(`https://127.0.0.1:${admin.port}`)
    expect(await getHTTPS(`${admin.origin}/ops`)).toEqual({
      status: 200,
      body: { protocol: 'https', httpVersion: '1.1' },
    })

    expect(app.address!.origin).toBe(`http://127.0.0.1:${app.address!.port}`)
    expect(await (await fetch(`${app.address!.origin}/api`)).json()).toEqual({ protocol: 'http', httpVersion: '1.1' })
  })

  it('serves plain HTTP on the listener while the application server serves HTTPS', async () => {
    app = createWebApplication()
      .install(Listener('admin', l => l.server(() => ({ listener }))))
      .server(() => ({ factory: { https: testTLS() }, listener }))
      .mount(echo('/ops').extend(bindTo('admin')), echo('/api')) as WebApplication

    await app.run()

    const admin = app.listeners.get('admin')!.address!
    expect(admin.origin).toBe(`http://127.0.0.1:${admin.port}`)
    expect(await (await fetch(`${admin.origin}/ops`)).json()).toEqual({ protocol: 'http', httpVersion: '1.1' })

    expect(app.address!.origin).toBe(`https://127.0.0.1:${app.address!.port}`)
    expect(await getHTTPS(`${app.address!.origin}/api`)).toEqual({
      status: 200,
      body: { protocol: 'https', httpVersion: '1.1' },
    })
  })

  it('serves HTTP/2 over TLS on the listener', async () => {
    app = createWebApplication()
      .install(Listener('admin', l => l.server(() => ({ factory: { http2: true, https: testTLS() }, listener }))))
      .mount(echo('/ops').extend(bindTo('admin'))) as WebApplication

    await app.run()

    expect(await getH2(session(app.listeners.get('admin')!.address!.origin), '/ops')).toEqual({
      status: 200,
      body: { protocol: 'https', httpVersion: '2.0' },
    })
  })

  // An HTTP/2 server ends its sessions only gracefully on close, so a stream that overran the budget is cut by the
  // forced teardown or not at all: the listener's must be cut too, not only the application's own.
  it('cuts an overrunning HTTP/2 stream on the listener when the shutdown budget runs out', async () => {
    let started!: () => void
    const inFlight = new Promise<void>(resolve => (started = resolve))
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))

    app = createWebApplication()
      .install(Listener('admin', l => l.server(() => ({ factory: { http2: true, https: testTLS() }, listener }))))
      .shutdown(s => s.drainDelay(0).shutdownTimeout(200))
      .mount(
        newRouter('/slow')
          .extend(bindTo('admin'))
          .get('/', async () => {
            started()
            await held
            return { ok: true }
          }),
      ) as WebApplication

    await app.run()
    const admin = app.listeners.get('admin')!
    const request = getH2(session(admin.address!.origin), '/slow').catch((error: unknown) => error)
    await inFlight

    const error = await app.close().catch((error: unknown) => error)

    expect((error as AggregateError).errors[0]).toBeInstanceOf(ErrShutdownTimeout)
    expect(admin.instance.server.listening).toBe(false)
    expect(await request).toBeInstanceOf(Error)

    release()
    app = undefined
  })
})
