import { $i, CaffeineIoC, Scopes, type NamedToken, type Provider } from '@caffeinejs/di'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { z } from 'zod'

import { CONFIG_REFRESH_LABEL, ConfigStore, type ConfigSource, type InferConfig } from './config/index.js'
import { InlineConfigSource } from './config/sources/inline/index.js'
import { newConfiguration } from './configuration.js'
import { createApplication } from './index.js'
import { $t } from './schema/t.js'

const schema = z.object({
  server: z.object({ host: z.string(), port: z.coerce.number() }),
})
type AppConfig = InferConfig<typeof schema>

/** A live source over data the test replaces. */
function remote(initial: { server: { host: string; port: number } }) {
  const state = { data: initial }
  const source: ConfigSource = { name: 'remote', live: true, load: () => [{ name: 'remote', data: state.data }] }
  return { source, state }
}

describe('newConfiguration', () => {
  it('binds the application config under the config token, a later source winning', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ server: { host: 'fallback', port: 9999 } }, 'fallback'))
      .source(new InlineConfigSource({ server: { host: 'primary', port: 3000 } }, 'primary'))
      .build()
    const app = createApplication({ container, config: conf.config })

    await app.bootstrap()

    // No type argument: the token carries the type the schema declares, which is the point of minting it there.
    const config = app.container.get(conf.configToken)
    expectTypeOf(config).toEqualTypeOf<AppConfig>()
    expect(config.server.host).toBe('primary')
    expect(config.server.port).toBe(3000)
  })

  it('types every token after the schema', () => {
    const conf = newConfiguration(schema).build()

    expectTypeOf(conf.configToken).toEqualTypeOf<NamedToken<AppConfig>>()
    expectTypeOf(conf.liveConfigToken).toEqualTypeOf<NamedToken<Provider<AppConfig>>>()
    expectTypeOf(conf.storeToken).toEqualTypeOf<NamedToken<ConfigStore<AppConfig>>>()
    expect(conf.config.configToken).toBe(conf.configToken)
    expect(conf.config.liveConfigToken).toBe(conf.liveConfigToken)
    expect(conf.config.storeToken).toBe(conf.storeToken)
  })

  // The class key erases the configuration type; the store token is how an application gets the store back typed.
  it('binds the store under the store token, typed, and it is the store under the class', async () => {
    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ server: { host: 'h', port: 1 } }))
      .build()
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf.config })

    await app.bootstrap()

    const store = app.container.get(conf.storeToken)
    expectTypeOf(store).toEqualTypeOf<ConfigStore<AppConfig>>()
    expect(store).toBe(app.container.get(ConfigStore))
    expect(store.current.server.host).toBe('h')
  })

  // Two configurations in one container must never answer to each other's tokens.
  it('mints new tokens on every build', () => {
    const builder = newConfiguration(schema)
    const a = builder.build()
    const b = builder.build()

    expect(a.configToken).not.toBe(b.configToken)
    expect(a.liveConfigToken).not.toBe(b.liveConfigToken)
    expect(a.storeToken).not.toBe(b.storeToken)
  })

  it('requires a schema', () => {
    // @ts-expect-error - a configuration is declared by its schema
    newConfiguration()

    // @ts-expect-error - sources alone are not a configuration declaration
    newConfiguration(c => c.source(new InlineConfigSource({ server: { host: 'x', port: 1 } })))
  })

  // The sources are data once built: nothing added afterwards could be seen by a load that already happened.
  it('fixes the definition at build()', () => {
    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ server: { host: 'h', port: 1 } }))
      .build()

    expect(Object.isFrozen(conf)).toBe(true)
    expect(Object.isFrozen(conf.config)).toBe(true)
    expect(Object.isFrozen(conf.config.sources)).toBe(true)
    expect(() => (conf.config.sources as ConfigSource[]).push(new InlineConfigSource({}, 'late'))).toThrow(TypeError)
  })

  // The list form registers in the order written, after what was already there: a later source still wins.
  it('adds several sources at once, in order', () => {
    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({}, 'defaults'))
      .sources(new InlineConfigSource({}, 'file'), new InlineConfigSource({}, 'env'))
      .build()

    expect(conf.config.sources.map(source => source.name)).toEqual(['defaults', 'file', 'env'])
  })

  it('bounds each load by 30 seconds unless told otherwise', () => {
    expect(newConfiguration(schema).build().config.loadTimeoutMs).toBe(30_000)
    expect(newConfiguration(schema).loadTimeout('5s').build().config.loadTimeoutMs).toBe(5_000)
    expect(newConfiguration(schema).loadTimeout(250).build().config.loadTimeoutMs).toBe(250)
  })

  // Data once built, like the sources: what the loader and the paths were when build() ran is what loads.
  it('carries the dotenv options into the definition, the last call winning', () => {
    const loader = (): void => {}

    const conf = newConfiguration(schema)
      .dotEnv({ loader, path: 'first' })
      .dotEnv({ loader, path: 'config', baseName: 'app.env' })
      .build()

    expect(newConfiguration(schema).build().config.dotenv).toBeUndefined()
    expect(conf.config.dotenv).toEqual({ loader, path: 'config', baseName: 'app.env' })
    expect(Object.isFrozen(conf.config.dotenv)).toBe(true)
  })

  // The config token is what the application started with, for every consumer, whenever it is built. Reading the
  // configuration as it is now is the live token's job.
  it('keeps the config token at the start-up values after a refresh, while the live token follows it', async () => {
    const { source, state } = remote({ server: { host: 'before', port: 80 } })
    const conf = newConfiguration(schema).source(source).build()
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf.config })

    await app.bootstrap()

    const live = app.container.get(conf.liveConfigToken)
    expect(live.get().server.host).toBe('before')

    state.data = { server: { host: 'after', port: 443 } }
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(live.get().server.host).toBe('after')
    expect(live.get().server.port).toBe(443)
    expect(app.container.get(conf.configToken).server.host).toBe('before')
    expect(app.config.server.host).toBe('after')
  })

  it('binds the store under its class, and it follows a reload', async () => {
    const { source, state } = remote({ server: { host: 'before', port: 80 } })
    const conf = newConfiguration(schema).source(source).build()
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf.config })

    await app.bootstrap()

    const store = app.container.get(ConfigStore)
    expect(store.revision).toBe(0)
    expect(store.explain('server.host').layers.map(l => l.layer)).toEqual(['remote'])

    state.data = { server: { host: 'after', port: 443 } }
    await store.reload()

    expect(app.container.get(ConfigStore)).toBe(store)
    expect(store.revision).toBe(1)
    expect((store.current as AppConfig).server.host).toBe('after')
  })

  it('loads an application that declared no configuration of its own', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const app = createApplication({ container })

    await app.bootstrap()

    expect(app.container.get(ConfigStore).current).toEqual({})
  })

  it('reads command-line arguments, above every other source', async () => {
    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ server: { host: 'from-code', port: 1 } }))
      .argv({ argv: ['/usr/bin/node', '/app/main.js', '--server.host=from-args'] })
      .build()
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf.config })

    await app.run()

    expect(app.container.get(conf.configToken).server.host).toBe('from-args')
    await app.close()
  })

  it('takes the host arguments when .argv() names none', async () => {
    const original = process.argv
    process.argv = ['/usr/bin/node', '/app/main.js', '--server.host=from-process']

    try {
      const conf = newConfiguration(schema)
        .source(new InlineConfigSource({ server: { host: 'from-code', port: 1 } }))
        .argv()
        .build()
      const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf.config })

      await app.run()

      expect(app.container.get(conf.configToken).server.host).toBe('from-process')
      await app.close()
    } finally {
      process.argv = original
    }
  })
})

const databaseSchema = $t.Object({
  database: $t.Object({
    host: $t.String(),
    port: $t.Number(),
  }),
})

type DatabaseConfig = { database: { host: string; port: number } }

function appWith(...sources: Array<{ provider: ConfigSource }>) {
  const container = new CaffeineIoC({ decorators: false })
  const configBuilder = newConfiguration(databaseSchema)
  for (const { provider } of sources) {
    configBuilder.source(provider)
  }
  const conf = configBuilder.build()
  const builder = createApplication({ container, config: conf.config })

  return { builder, container, conf }
}

describe('configuration as the DI values provider', () => {
  it('injects a value selected by function', async () => {
    class Repository {
      constructor(readonly host: string) {}
    }

    const { builder, container } = appWith({
      provider: new InlineConfigSource({ database: { host: 'db.local', port: 5432 } }),
    })
    container.bind(Repository, t => t.toSelf([$i.config<DatabaseConfig, string>(c => c.database.host)]))

    await builder.bootstrap()

    expect(container.get(Repository).host).toBe('db.local')
  })

  it('injects a value selected by dot-path, and honours a default', async () => {
    class Repository {
      constructor(
        readonly port: number,
        readonly missing: string,
      ) {}
    }

    const { builder, container } = appWith({
      provider: new InlineConfigSource({ database: { host: 'h', port: 5432 } }),
    })
    container.bind(Repository, t =>
      t.toSelf([
        $i.config<DatabaseConfig, number>('database.port'),
        $i.config<DatabaseConfig, string>('database.missing', 'fallback'),
      ]),
    )

    await builder.bootstrap()

    const repository = container.get(Repository)
    expect(repository.port).toBe(5432)
    expect(repository.missing).toBe('fallback')
  })

  // `$i.config` reads the start-up values, even for a consumer built after a refresh; `$i.liveConfig` is the one
  // that reads the configuration as it is now, on every `get()`.
  it('keeps $i.config at the start-up values, while $i.liveConfig follows a refresh', async () => {
    class Holder {
      constructor(
        readonly host: string,
        readonly liveHost: Provider<string>,
      ) {}
    }

    let database = { host: 'first', port: 5432 }
    const changing: ConfigSource = { name: 'test', live: true, load: () => [{ name: 'test', data: { database } }] }

    const { builder, container, conf } = appWith({ provider: changing })
    container.bind(Holder, t =>
      t
        .toSelf([
          $i.config<DatabaseConfig, string>(c => c.database.host),
          $i.liveConfig<DatabaseConfig, string>(c => c.database.host),
        ])
        .lifetime(Scopes.TRANSIENT),
    )

    await builder.bootstrap()

    const before = container.get(Holder)
    expect(before.host).toBe('first')

    database = { host: 'second', port: 5432 }
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(container.get(conf.liveConfigToken).get().database.host).toBe('second')
    expect(container.get(Holder).host).toBe('first')
    expect(before.liveHost.get()).toBe('second')
  })

  it('leaves an application-supplied values provider alone', async () => {
    class Holder {
      constructor(readonly own: string) {}
    }

    const { builder, container } = appWith({
      provider: new InlineConfigSource({ database: { host: 'h', port: 1 } }),
    })
    container.bindConfig<{ own: string }>({ own: 'mine' })
    container.bind(Holder, t => t.toSelf([$i.config<{ own: string }, string>(c => c.own)]))

    await builder.bootstrap()

    expect(container.get(Holder).own).toBe('mine')
  })
})

const pricingSchema = $t.Object({ pricing: $t.Object({ margin: $t.Number() }) })

// The feature the whole package exists for, end to end: a live source changes a part of the tree, and a service
// that was handed the live token once reads the new value, with nobody calling a refresh.
describe('live configuration', () => {
  it('reaches a singleton through the live token it was injected with', async () => {
    const conf = newConfiguration(pricingSchema)
    type PricingConfig = InferConfig<typeof pricingSchema>

    class Pricing {
      constructor(private readonly config: Provider<PricingConfig>) {}

      quote(): number {
        return this.config.get().pricing.margin
      }
    }

    // A source that says when it changed. Nothing below asks for a reload: the store loads it again by itself.
    let margin = 0.2
    let changed: (() => void) | undefined
    const overrides: ConfigSource = {
      name: 'overrides',
      load: () => [{ name: 'overrides', data: { pricing: { margin } } }],
      watch: listener => {
        changed = listener
        return () => {
          changed = undefined
        }
      },
    }
    const built = conf.source(overrides).build()
    const container = new CaffeineIoC({ decorators: false })
    container.bind(Pricing, t => t.toSelf([built.liveConfigToken]))
    const app = createApplication({ container, config: built.config })
    await app.bootstrap()

    const pricing = app.container.get(Pricing)
    expect(pricing.quote()).toBe(0.2)

    margin = 0.35
    changed?.()

    await vi.waitFor(() => expect(pricing.quote()).toBe(0.35))
    expect(app.container.get(Pricing)).toBe(pricing)

    await app.close()
  })

  // What a singleton injecting the config token reads is fixed, by design: it is the configuration it started with.
  it('keeps a singleton injecting the config token at the values it was built with', async () => {
    const { source, state } = remote({ server: { host: 'before', port: 80 } })
    const conf = newConfiguration(schema).source(source).build()

    class Client {
      constructor(readonly config: AppConfig) {}
    }

    const container = new CaffeineIoC({ decorators: false })
    container.bind(Client, t => t.toSelf([conf.configToken]))
    const app = createApplication({ container, config: conf.config })
    await app.bootstrap()

    state.data = { server: { host: 'after', port: 443 } }
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(app.container.get(Client).config.server.host).toBe('before')
  })
})
