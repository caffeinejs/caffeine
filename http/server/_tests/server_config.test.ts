import type { AddressInfo } from 'node:net'

import { type InferSchema, kAppConfig, $t } from '@caffeinejs/std'
import {
  CONFIG_REFRESH_LABEL,
  ConfigPriority,
  EnvConfigProvider,
  InlineConfigProvider,
  type ConfigHandle,
  type ConfigProvider,
} from '@caffeinejs/std/config'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { WebApplication, createWebApplication, fastifyAdapterFactory } from '../../index.js'
import { DEFAULT_SERVER_OPTIONS, kServerContribution } from '../index.js'

const schema = $t.Object({
  server: $t.Object({ host: $t.String(), port: $t.Number() }),
  db: $t.Object({ url: $t.String() }),
})

type AppConfig = InferSchema<typeof schema>

/** An env source over a fixed map, so the tests never touch the real environment. */
function env(values: Record<string, string>): ConfigProvider {
  return new EnvConfigProvider({ env: values })
}

describe('server builder + config', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('drives the listen address from the application config slice', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, c =>
        c.source(new InlineConfigProvider({ server: { host: '127.0.0.1', port: 0 }, db: { url: 'x' } })),
      )
      .server(s => s.config(c => c.server))
      .build()

    await app.run()

    const address = app.instance.server.address() as AddressInfo
    expect(address.address).toBe('127.0.0.1')
    expect(address.port).toBeGreaterThan(0)
  })

  it('layers a code-set port under the environment rather than conflicting with it', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, c =>
        c.source(env({ SERVER__HOST: '127.0.0.1', SERVER__PORT: '8080', DB__URL: 'x' }), ConfigPriority.ENV),
      )
      .server(s => s.port(3000).host('0.0.0.0'))
      .build()

    await app.ready()

    // The environment wins: a port compiled into the image is a default, not an override.
    expect(app.contributions.get(kServerContribution)).toEqual({ host: '127.0.0.1', port: 8080 })
  })

  it('falls back to the code-set port when the environment says nothing', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, c => c.source(env({ DB__URL: 'x' }), ConfigPriority.ENV))
      .server(s => s.port(3000).host('127.0.0.1'))
      .build()

    await app.ready()

    expect(app.contributions.get(kServerContribution)).toEqual({ host: '127.0.0.1', port: 3000 })
  })

  it('falls back to the framework defaults when neither says anything', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify())).build()

    await app.ready()

    expect(app.contributions.get(kServerContribution)).toEqual(DEFAULT_SERVER_OPTIONS)
  })

  it('configures the server from the environment with no .server() call at all', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, c =>
        c.source(env({ SERVER__HOST: '127.0.0.1', SERVER__PORT: '8081', DB__URL: 'x' }), ConfigPriority.ENV),
      )
      .build()

    await app.ready()

    expect(app.contributions.get(kServerContribution)).toEqual({ host: '127.0.0.1', port: 8081 })
  })

  it('lets command-line arguments beat both the environment and the code', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, c =>
        c
          .source(env({ SERVER__HOST: '127.0.0.1', SERVER__PORT: '8080', DB__URL: 'x' }), ConfigPriority.ENV)
          // Given exactly as `process.argv` arrives, interpreter and script path included.
          .args({ argv: ['/usr/bin/node', '/app/main.js', '--server.port=9090'] }),
      )
      .server(s => s.port(3000))
      .build()

    await app.ready()

    expect(app.contributions.get(kServerContribution)).toEqual({ host: '127.0.0.1', port: 9090 })
  })

  it('re-points the whole feature — reads and code-set defaults — through the selector', async () => {
    const nested = $t.Object({
      app: $t.Object({ server: $t.Object({ host: $t.String(), port: $t.Number() }) }),
    })

    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(nested, c => c.source(env({ APP__SERVER__HOST: '127.0.0.1' }), ConfigPriority.ENV))
      .server(s => s.config(c => c.app.server).port(4567))
      .build()

    await app.ready()

    // `port` came from the builder at the re-pointed namespace, `host` from the environment at the same one.
    expect(app.contributions.get(kServerContribution)).toEqual({ host: '127.0.0.1', port: 4567 })
  })

  it('lets the environment override a re-pointed namespace', async () => {
    const nested = $t.Object({
      app: $t.Object({ server: $t.Object({ host: $t.String(), port: $t.Number() }) }),
    })

    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(nested, c => c.source(env({ APP__SERVER__PORT: '8082' }), ConfigPriority.ENV))
      .server(s => s.config(c => c.app.server).port(4567))
      .build()

    await app.ready()

    expect(app.contributions.get(kServerContribution).port).toBe(8082)
  })

  it('resolves against the defaults when a selector is used without an application config', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      // No `.config(...)` declared — the tree still exists, so the selector simply names a place in it.
      .server(s => s.config(c => (c as ConfigHandle<AppConfig>).server).port(4444))
      .build()

    await app.ready()

    expect(app.contributions.get(kServerContribution)).toEqual({ host: DEFAULT_SERVER_OPTIONS.host, port: 4444 })
  })

  it('follows a config refresh, without the bound socket moving', async () => {
    let data = { server: { host: '127.0.0.1', port: 0 }, db: { url: 'x' } }
    const mutable: ConfigProvider = {
      id: 'mutable',
      reloadable: true,
      load: ctx => new InlineConfigProvider(data).load(ctx),
    }

    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, c => c.source(mutable))
      .server(s => s.config(c => c.server))
      .build()

    await app.run()

    const bound = (app.instance.server.address() as AddressInfo).port
    expect(bound).toBeGreaterThan(0)

    data = { server: { host: '0.0.0.0', port: 1234 }, db: { url: 'x' } }
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    // The options are configuration like any other, so they report what configuration now says.
    expect(app.container.get<ConfigHandle<AppConfig>>(kAppConfig).server.port).toBe(1234)
    expect(app.contributions.get(kServerContribution)).toEqual({ host: '0.0.0.0', port: 1234 })

    // The socket does not move: the address was fixed when the adapter took these values and listened. That is
    // the server's business, not a property of the configuration layer.
    expect((app.instance.server.address() as AddressInfo).port).toBe(bound)
  })

  it('rejects a selector whose slice is not ServerOptions (compile-time)', () => {
    void createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, c => c.source(new InlineConfigProvider({ server: { host: 'h', port: 1 }, db: { url: 'u' } })))
      // @ts-expect-error the `db` slice ({ url }) is not assignable to ServerOptions
      .server(s => s.config(c => c.db))
  })
})
