import type { AddressInfo } from 'node:net'

import { token } from '@caffeinejs/di'
import { newConfiguration, type InferSchema, $t } from '@caffeinejs/std'
import {
  CONFIG_REFRESH_LABEL,
  EnvConfigSource,
  InlineConfigSource,
  type InferConfig,
  type LiveConfig,
  type ConfigSource,
} from '@caffeinejs/std/config'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { WebApplication, createWebApplication, fastifyAdapterFactory } from '../../index.js'
import { DEFAULT_SERVER_OPTIONS, kServerOptions, serverConfigSchema, type ServerOptions } from '../index.js'

// The application imports the feature's own schema rather than restating the fields, which is what carries
// the server's defaults into the tree: a feature seeds nothing there any more.
const schema = $t.Object({
  server: $t.Object(serverConfigSchema.properties, { default: {} }),
  db: $t.Object({ url: $t.String() }),
})

type AppConfig = InferSchema<typeof schema>

const kConfig = token<InferConfig<typeof schema>>(Symbol('app.config'))

/** An env source over a fixed map, so the tests never touch the real environment. */
function env(values: Record<string, string>): ConfigSource {
  return new EnvConfigSource({ env: values })
}

/**
 * What the adapter reads: the server settings by key, wherever the application put them — and whether or not
 * the application declared a configuration of its own.
 */
function serverConfig(app: WebApplication): ServerOptions {
  return app.container.get(kServerOptions)
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
    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ server: { host: '127.0.0.1', port: 0 }, db: { url: 'x' } }))
      .build()
    app = createWebApplication(fastifyAdapterFactory(fastify()), { config: conf }).server((s, c) => s.config(c.server))

    await app.run()

    const address = app.instance.server.address() as AddressInfo
    expect(address.address).toBe('127.0.0.1')
    expect(address.port).toBeGreaterThan(0)
  })

  // A fluent method is the last word, even alongside a wired block: `.port(3000)` is what the socket binds
  // to, and only `host` — which the code did not set — comes from the environment.
  it('keeps a code-set port while still reading the rest from the environment', async () => {
    const conf = newConfiguration(schema, kConfig)
      .source(env({ SERVER__HOST: '127.0.0.1', SERVER__PORT: '8080', DB__URL: 'x' }))
      .build()
    app = createWebApplication(fastifyAdapterFactory(fastify()), { config: conf }).server((s, c) =>
      s.config(c.server).port(3000),
    )

    await app.ready()

    expect(serverConfig(app)).toEqual({ host: '127.0.0.1', port: 3000 })
  })

  it('reads the port from the environment when the code set none', async () => {
    const conf = newConfiguration(schema, kConfig)
      .source(env({ SERVER__HOST: '127.0.0.1', SERVER__PORT: '8080', DB__URL: 'x' }))
      .build()
    app = createWebApplication(fastifyAdapterFactory(fastify()), { config: conf }).server((s, c) => s.config(c.server))

    await app.ready()

    expect(serverConfig(app)).toEqual({ host: '127.0.0.1', port: 8080 })
  })

  it('falls back to the code-set port when the environment says nothing', async () => {
    const conf = newConfiguration(schema, kConfig)
      .source(env({ DB__URL: 'x' }))
      .build()
    app = createWebApplication(fastifyAdapterFactory(fastify()), { config: conf }).server((s, c) =>
      s.config(c.server).port(3000).host('127.0.0.1'),
    )

    await app.ready()

    expect(serverConfig(app)).toEqual({ host: '127.0.0.1', port: 3000 })
  })

  it('falls back to the framework defaults when neither says anything', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))

    await app.ready()

    expect(serverConfig(app)).toEqual(DEFAULT_SERVER_OPTIONS)
  })

  // Declaring `server` in the schema is not on its own an instruction to configure the server from it: a
  // feature reads what the application pointed it at, and nothing pointed here.
  it('leaves the server on its defaults when nothing pointed it at the block', async () => {
    const conf = newConfiguration(schema, kConfig)
      .source(env({ SERVER__HOST: '127.0.0.1', SERVER__PORT: '8081', DB__URL: 'x' }))
      .build()
    app = createWebApplication(fastifyAdapterFactory(fastify()), { config: conf })

    await app.ready()

    expect(serverConfig(app)).toEqual(DEFAULT_SERVER_OPTIONS)
  })

  // The bands still layer among themselves — args over env — and the winner of that is what the wired block
  // hands the feature. What no longer happens is configuration outranking the code.
  it('lets command-line arguments beat the environment in the block the feature reads', async () => {
    const conf = newConfiguration(schema, kConfig)
      .source(env({ SERVER__HOST: '127.0.0.1', SERVER__PORT: '8080', DB__URL: 'x' }))
      // Given exactly as `process.argv` arrives, interpreter and script path included.
      .args({ argv: ['/usr/bin/node', '/app/main.js', '--server.port=9090'] })
      .build()
    app = createWebApplication(fastifyAdapterFactory(fastify()), { config: conf }).server((s, c) => s.config(c.server))

    await app.ready()

    expect(serverConfig(app)).toEqual({ host: '127.0.0.1', port: 9090 })
  })

  it('reads the block wherever the application put it, with the code still winning per key', async () => {
    const nested = $t.Object({
      app: $t.Object({ server: $t.Object(serverConfigSchema.properties, { default: {} }) }, { default: {} }),
    })
    const kNested = token<InferConfig<typeof nested>>(Symbol('app.config'))

    const conf = newConfiguration(nested, kNested)
      .source(env({ APP__SERVER__HOST: '127.0.0.1' }))
      .build()
    app = createWebApplication(fastifyAdapterFactory(fastify()), { config: conf }).server((s, c) =>
      s.config(c.app.server).port(4567),
    )

    await app.ready()

    // `port` came from the builder at the block the application named, `host` from the environment at the same one.
    expect(serverConfig(app)).toEqual({ host: '127.0.0.1', port: 4567 })
  })

  it('reads the environment at the block the application named', async () => {
    const nested = $t.Object({
      app: $t.Object({ server: $t.Object(serverConfigSchema.properties, { default: {} }) }, { default: {} }),
    })
    const kNested = token<InferConfig<typeof nested>>(Symbol('app.config'))

    const conf = newConfiguration(nested, kNested)
      .source(env({ APP__SERVER__PORT: '8082' }))
      .build()
    app = createWebApplication(fastifyAdapterFactory(fastify()), { config: conf }).server((s, c) =>
      s.config(c.app.server),
    )

    await app.ready()

    expect(serverConfig(app).port).toBe(8082)
  })

  it('resolves against the defaults when the application declared no schema', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      // No `config` constructor option — the block reads back empty, so the defaults and the code value stand.
      .server((s, c) => s.config((c as LiveConfig<AppConfig>).server).port(4444))

    await app.ready()

    expect(serverConfig(app)).toEqual({ host: DEFAULT_SERVER_OPTIONS.host, port: 4444 })
  })

  it('does not follow a config refresh once the options are bound', async () => {
    let data = { server: { host: '127.0.0.1', port: 0 }, db: { url: 'x' } }
    const mutable: ConfigSource = {
      name: 'mutable',
      live: true,
      load: () => new InlineConfigSource(data, 'mutable').load(),
    }

    const conf = newConfiguration(schema, kConfig).source(mutable).build()
    app = createWebApplication(fastifyAdapterFactory(fastify()), { config: conf }).server((s, c) => s.config(c.server))

    await app.run()

    const bound = (app.instance.server.address() as AddressInfo).port
    expect(bound).toBeGreaterThan(0)

    data = { server: { host: '0.0.0.0', port: 1234 }, db: { url: 'x' } }
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    // The configuration tree itself keeps refreshing...
    expect(app.container.get(kConfig).server.port).toBe(1234)
    // ...but the server's own options were read once, when the feature configured, and do not follow it.
    expect(serverConfig(app)).toEqual({ host: '127.0.0.1', port: 0 })

    // The socket does not move either way: the address was fixed when the adapter took these values and
    // listened. That is the server's business, not a property of the configuration layer.
    expect((app.instance.server.address() as AddressInfo).port).toBe(bound)
  })

  it('rejects a selector whose slice is not ServerOptions (compile-time)', () => {
    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ server: { host: 'h', port: 1 }, db: { url: 'u' } }))
      .build()
    void createWebApplication(fastifyAdapterFactory(fastify()), { config: conf })
      // @ts-expect-error the `db` slice ({ url }) is not assignable to ServerOptions
      .server((s, c) => s.config(c.db))
  })
})
