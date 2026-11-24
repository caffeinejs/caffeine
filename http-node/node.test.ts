import { once } from 'node:events'
import { get as httpGet } from 'node:http'
import { connect as http2Connect } from 'node:http2'
import { get as httpsGet } from 'node:https'
import type { Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { newConfiguration } from '@caffeinejs/application'
import { EnvConfigSource } from '@caffeinejs/application/config/env'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { newNoopLogger } from '@caffeinejs/application/logger'
import { $t } from '@caffeinejs/application/schema'
import { type AnyRouter, createWebApplication, Router, type WebApplication } from '@caffeinejs/http'
import { testTLS } from '@caffeinejs/testing/tls'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { node, type NodeAdapter } from './node.js'

const { key, cert } = testTLS()

type App = WebApplication<never, never, unknown, NodeAdapter>

const apps: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()))
})

function hello(): AnyRouter {
  const routes = new Router('/hi')
  routes.get('/').handler(ctx => ({
    host: ctx.req.host,
    protocol: ctx.req.protocol,
    url: ctx.req.raw.url,
    platform: ctx.platform.name,
  }))
  return routes
}

function app(settings: object = {}): App {
  const built = createWebApplication({ adapter: node() })
    .logger(b => b.use(newNoopLogger()))
    .server(() => settings as never)
    .mount(hello())
  apps.push(built)
  return built
}

function loopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

function body(get: typeof httpGet | typeof httpsGet, options: object): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    get(options, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode!, text }))
    }).on('error', reject)
  })
}

function http2Get(origin: string, path: string, options: object = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const session = http2Connect(origin, options)
    session.on('error', reject)
    const stream = session.request({ ':path': path })
    let status = 0
    let text = ''
    stream.setEncoding('utf8')
    stream.on('response', headers => (status = Number(headers[':status'])))
    stream.on('data', chunk => (text += chunk))
    stream.on('end', () => {
      session.close()
      resolve({ status, text })
    })
    stream.end()
  })
}

describe('the Node application', () => {
  it('lets registered work outlive a live response and drains it before onClose', async () => {
    const held = Promise.withResolvers<void>()
    const events: string[] = []
    const router = new Router('/work')
    router.get('/').handler(ctx => {
      const waitUntil = ctx.server.waitUntil!
      waitUntil(held.promise.then(() => void events.push('work')))
      return 'answered'
    })
    const built = app()
      .mount(router)
      .hook('onResponse', () => void events.push('response'))
      .hook('onClose', () => void events.push('close'))
    const { address } = await built.run({ host: '127.0.0.1', port: 0 })

    try {
      const response = await fetch(`${address.origin}/work`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('answered')
      expect(events).toEqual(['response'])

      const stoppedListening = once(built.instance, 'close')
      const closing = built.close()
      await stoppedListening
      expect(events).toEqual(['response'])

      held.resolve()
      await closing
      expect(events).toEqual(['response', 'work', 'close'])
    } finally {
      held.resolve()
    }
  })

  it('listens on loopback, on a port the OS assigns, when nothing says where', async () => {
    const { address } = await app().run()
    const host = address.host === '::1' ? '[::1]' : address.host

    expect(loopback(address.host)).toBe(true)
    expect(address.origin).toBe(`http://${host}:${address.port}`)
    expect(((await (await fetch(`${address.origin}/hi`)).json()) as { platform: string }).platform).toBe('node')
  })

  it('merges what run() is given over the listen settings, key by key', async () => {
    const { address } = await app({ listen: { host: '127.0.0.1', port: 1 } }).run({ port: 0 })

    expect(address.host).toBe('127.0.0.1')
    expect(address.port).not.toBe(1)
  })

  // Fastify's default: a port alone never binds every interface.
  it('binds loopback when run() names a port and no host', async () => {
    const { address } = await app().run({ port: 0 })

    expect(loopback(address.host)).toBe(true)
  })

  it('binds loopback when the listen settings leave the host undefined', async () => {
    const { address } = await app({ listen: { host: undefined, port: 0 } }).run()

    expect(loopback(address.host)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('binds a unix socket, reports its path and serves on it', async () => {
    const path = join(tmpdir(), `caffeine-node-${process.pid}-${Date.now()}.sock`)
    const { address } = await app().run({ path })

    expect(address).toEqual({ host: '', port: 0, path, origin: '' })
    expect((await body(httpGet, { socketPath: path, path: '/hi' })).status).toBe(200)
  })

  // A configuration node is frozen, and listen() writes into what it is handed.
  it('listens on frozen listen settings', async () => {
    const { address } = await app({ listen: Object.freeze({ host: '127.0.0.1', port: 0 }) }).run()

    expect(address.host).toBe('127.0.0.1')
  })

  it('renders a wildcard bind as a loopback origin', async () => {
    const { address } = await app().run({ host: '0.0.0.0', port: 0 })

    expect(address.origin).toBe(`http://127.0.0.1:${address.port}`)
  })

  it('rejects run() when the port is taken', async () => {
    const { address } = await app().run({ host: '127.0.0.1', port: 0 })

    await expect(app().run({ host: '127.0.0.1', port: address.port })).rejects.toMatchObject({ code: 'EADDRINUSE' })
  })

  it('logs where it listens', async () => {
    const info = vi.fn()
    const built = createWebApplication({ adapter: node() })
      .logger(b => b.use({ ...newNoopLogger(), info }))
      .mount(hello())
    apps.push(built)

    const { address } = await built.run({ host: '127.0.0.1', port: 0 })
    const listening = info.mock.calls.filter(call => String(call[1]).startsWith('Server listening at'))

    expect(listening).toEqual([[{ address: address.origin }, `Server listening at ${address.origin}`]])
  })

  it('serves TLS from the https settings and reports an https origin', async () => {
    const { address } = await app({ https: { key, cert } }).run({ host: '127.0.0.1', port: 0 })

    expect(address.origin).toBe(`https://127.0.0.1:${address.port}`)
    const res = await body(httpsGet, {
      host: '127.0.0.1',
      port: address.port,
      path: '/hi',
      ca: cert,
      servername: 'localhost',
    })
    expect((JSON.parse(res.text) as { protocol: string }).protocol).toBe('https')
  })

  it('serves cleartext HTTP/2 under http2, its authority as the host', async () => {
    const { address } = await app({ http2: true }).run({ host: '127.0.0.1', port: 0 })

    const res = await http2Get(address.origin, '/hi')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text)).toMatchObject({
      host: `127.0.0.1:${address.port}`,
      url: `http://127.0.0.1:${address.port}/hi`,
    })
  })

  it('serves HTTP/2 over TLS, and HTTP/1.1 to a client that asks, under allowHTTP1', async () => {
    const { address } = await app({ https: { key, cert }, http2: { allowHTTP1: true } }).run({
      host: '127.0.0.1',
      port: 0,
    })

    expect((await http2Get(address.origin, '/hi', { ca: cert, servername: 'localhost' })).status).toBe(200)
    expect(
      (await body(httpsGet, { host: '127.0.0.1', port: address.port, path: '/hi', ca: cert, servername: 'localhost' }))
        .status,
    ).toBe(200)
  })

  it('hands .serverCallback(...) the Node server before it listens', async () => {
    let captured: unknown
    let listening: boolean | undefined
    const built = app().serverCallback((_, server) => {
      captured = server
      listening = (server as NetServer).listening
    })
    await built.bootstrap()

    expect(captured).toBe(built.instance)
    expect(listening).toBe(false)
  })

  // A listener's server is its own: what the application set up for its own server never reaches it.
  it("hands .serverCallback(...) the application's own server alone, never a listener's", async () => {
    const seen: unknown[] = []
    const built = app()
      .listener('admin', l => l.server(() => ({ listen: { host: '127.0.0.1', port: 0 } })))
      .serverCallback((_, server) => void seen.push(server))
    await built.bootstrap()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(built.instance)
  })

  it('answers fetch(request) as request() does, before it listens', async () => {
    const built = app()
    await built.bootstrap()

    expect(
      ((await (await built.fetch(new Request('http://localhost/hi'))).json()) as { platform: string }).platform,
    ).toBe('node')
  })

  it('serves a listener on its own listen settings', async () => {
    const built = createWebApplication({ adapter: node() })
      .logger(b => b.use(newNoopLogger()))
      .listener('admin', l =>
        l
          .server(() => ({ listen: { host: '127.0.0.1', port: 0 } }))
          .mount(new Router('/admin').get('/', () => ({ up: true }))),
      )
    apps.push(built)

    await built.run({ host: '127.0.0.1', port: 0 })
    const admin = built.listeners.get('admin')!

    expect(await (await fetch(`${admin.address!.origin}/admin`)).json()).toEqual({ up: true })
  })

  it('stops a server its callback made listen when the callback then fails', async () => {
    const boom = new Error('the callback failed')
    let captured: NetServer | undefined
    const built = app().serverCallback(async (_, server) => {
      captured = server as NetServer
      await new Promise<void>(resolve => captured!.listen(0, '127.0.0.1', () => resolve()))
      throw boom
    })

    await expect(built.bootstrap()).rejects.toBe(boom)
    expect(captured?.listening).toBe(false)
  })
})

// The listen settings read from the application's configuration, and what is reachable before bootstrap().
describe('the Node application from its configuration', () => {
  const schema = $t.Object({
    server: $t.Object({ host: $t.String({ default: '127.0.0.1' }), port: $t.Number({ default: 0 }) }, { default: {} }),
  })

  it('drives listen from a node of the application configuration', async () => {
    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ server: { host: '0.0.0.0', port: 0 } }))
      .build().config
    const built = createWebApplication({ adapter: node(), config: conf })
      .logger(b => b.use(newNoopLogger()))
      .server(({ config }) => ({ listen: config.server }))
    apps.push(built)

    await built.run()

    expect(built.address?.host).toBe('0.0.0.0')
  })

  it('reads listen from the environment when the node is fed from it', async () => {
    const conf = newConfiguration(schema)
      .source(new EnvConfigSource({ env: { SERVER__HOST: '0.0.0.0', SERVER__PORT: '0' } }))
      .build().config
    const built = createWebApplication({ adapter: node(), config: conf })
      .logger(b => b.use(newNoopLogger()))
      .server(({ config }) => ({ listen: config.server }))
    apps.push(built)

    await built.run()

    expect(built.address?.host).toBe('0.0.0.0')
  })
})
