import { token } from '@caffeinejs/di'
import { newConfiguration } from '@caffeinejs/std'
import {
  CONFIG_REFRESH_LABEL,
  EnvConfigSource,
  InlineConfigSource,
  type ConfigSource,
  type InferConfig,
} from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrApplicationNotReady } from './error/common.js'
import { Controller, Get, WebApplication, createWebApplication } from './index.js'

/**
 * The server the adapter builds from `.server(...)`: what reaches Fastify's constructor and its `listen()`, how
 * several calls fold together, what `run(...)` adds, and what is reachable before `ready()`.
 */

const schema = $t.Object({
  server: $t.Object({ host: $t.String({ default: '127.0.0.1' }), port: $t.Number({ default: 0 }) }, { default: {} }),
  db: $t.Object({ url: $t.String({ default: 'x' }) }, { default: {} }),
})

const kConfig = token<InferConfig<typeof schema>>(Symbol('app.config'))

@Controller('/adapter-server')
class AdapterServerController {
  @Get('/ping')
  ping() {
    return { ok: true }
  }
}

void [AdapterServerController]

describe('the server .server(...) configures', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('run() readies the application and serves on the listener', async () => {
    app = createWebApplication().server(() => ({ listener: { host: '127.0.0.1', port: 0 } }))

    await app.run()

    expect(app.address?.host).toBe('127.0.0.1')
    expect(app.address?.port).toBeGreaterThan(0)

    const res = await fetch(`${app.address!.origin}/adapter-server/ping`)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('binds once when ready() precedes run()', async () => {
    app = createWebApplication().server(() => ({ listener: { host: '127.0.0.1', port: 0 } }))

    await app.ready()
    expect(app.address).toBeUndefined()

    await app.run()

    expect(app.address?.port).toBeGreaterThan(0)
  })

  it('resolves run() to the address, rendering a wildcard host as a dialable loopback origin', async () => {
    app = createWebApplication().server(() => ({ listener: { host: '0.0.0.0', port: 0 } }))

    const info = await app.run()

    expect(info.address).toEqual(app.address)
    expect(info.address?.host).toBe('0.0.0.0')
    expect(info.address?.origin).toBe(`http://127.0.0.1:${info.address?.port}`)
  })

  // No framework default: with nothing said, Fastify's own `localhost` bind stands, whichever family it resolves to.
  it("listens on Fastify's own default when nothing was configured", async () => {
    app = createWebApplication()

    await app.run()

    expect(app.address?.port).toBeGreaterThan(0)
    expect(['127.0.0.1', '::1']).toContain(app.address?.host)
  })

  it('drives the listener from a node of the application configuration', async () => {
    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ server: { host: '127.0.0.1', port: 0 } }))
      .build()
    app = createWebApplication({ config: conf }).server(({ config }) => ({ listener: config.server }))

    await app.run()

    expect(app.address?.host).toBe('127.0.0.1')
  })

  it('reads the listener from the environment when the node is fed from it', async () => {
    const conf = newConfiguration(schema, kConfig)
      .source(new EnvConfigSource({ env: { SERVER__HOST: '127.0.0.1', SERVER__PORT: '0' } }))
      .build()
    app = createWebApplication({ config: conf }).server(({ config }) => ({ listener: config.server }))

    await app.run()

    expect(app.address?.host).toBe('127.0.0.1')
  })

  it('merges what run() is given over the listener, key by key', async () => {
    app = createWebApplication().server(() => ({ listener: { host: '0.0.0.0', port: 0 } }))

    await app.run({ host: '127.0.0.1' })

    expect(app.address?.host).toBe('127.0.0.1')
  })

  it('folds several calls: sections merge in call order, server callbacks run in call order on the bare server', async () => {
    const seen: string[] = []

    app = createWebApplication()
      .server(() => ({ listener: { host: '0.0.0.0' } }))
      .serverCallback((_context, instance) => {
        seen.push(`first:${instance.hasDecorator('$container')}`)
      })
      .server(() => ({ listener: { host: '127.0.0.1', port: 0 }, factory: { bodyLimit: 2048 } }))
      .serverCallback(() => {
        seen.push('second')
      })

    await app.run()

    expect(seen).toEqual(['first:false', 'second'])
    expect(app.instance.hasDecorator('$container')).toBe(true)
    expect(app.address?.host).toBe('127.0.0.1')
    expect(app.instance.initialConfig.bodyLimit).toBe(2048)
  })

  it('hands a server callback the context a plugin factory gets, typed by the configuration, then the bare server', async () => {
    const conf = newConfiguration(schema, kConfig).build()
    let factoryContext: unknown
    let callbackContext: unknown
    let dbURL: string | undefined
    let decorated: boolean | undefined

    app = createWebApplication({ config: conf })
      .with(context => {
        factoryContext = context
        return async () => {}
      })
      .serverCallback((context, instance) => {
        callbackContext = context
        // Compiles only because the application's configuration type reaches the callback.
        dbURL = context.config.db.url
        decorated = instance.hasDecorator('$container')
      })

    await app.ready()

    expect(callbackContext).toBe(factoryContext)
    expect(dbURL).toBe('x')
    expect(decorated).toBe(false)
  })

  it('constructs Fastify with the factory section', async () => {
    app = createWebApplication().server(() => ({ factory: { routerOptions: { ignoreTrailingSlash: true } } }))

    await app.ready()

    const res = await app.fetch('/adapter-server/ping/')
    expect(res.status).toBe(200)
  })

  it('reads a live listener node once and leaves it untouched by a refresh', async () => {
    let data = { server: { host: '127.0.0.1', port: 0 } }
    const mutable: ConfigSource = {
      name: 'mutable',
      live: true,
      load: () => new InlineConfigSource(data, 'mutable').load(),
    }

    const conf = newConfiguration(schema, kConfig).source(mutable).build()
    app = createWebApplication({ config: conf }).server(({ config }) => ({ listener: config.server }))

    await app.run()

    const bound = app.address!.port
    expect(bound).toBeGreaterThan(0)

    data = { server: { host: '0.0.0.0', port: 1234 } }
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    // The tree keeps refreshing; the socket was bound off a copy and does not move.
    expect(app.container.get(kConfig).server.port).toBe(1234)
    expect(app.address!.port).toBe(bound)
  })

  it('has no server to reach before ready()', async () => {
    app = createWebApplication()

    expect(() => app!.instance).toThrow(ErrApplicationNotReady)
    await expect(app.fetch('/adapter-server/ping')).rejects.toThrow(ErrApplicationNotReady)
    expect(app.address).toBeUndefined()

    // Closing what never readied is fine: there is nothing to tear down.
    await app.close()
    app = undefined
  })

  it('rejects a node that is not listen options (compile-time)', () => {
    const conf = newConfiguration(schema, kConfig).build()

    void createWebApplication({ config: conf })
      // @ts-expect-error the `db` node ({ url }) is not assignable to FastifyListenOptions
      .server(({ config }) => ({ listener: config.db }))
  })
})
