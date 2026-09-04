import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'

import {
  CONFIG_REFRESH_LABEL,
  Configuration,
  ConfigPriority,
  InlineConfigProvider,
  defineFeatureConfig,
  type ConfigHandle,
  type ConfigProvider,
} from './config/index.js'
import { createApplication } from './index.js'

const schema = z.object({
  server: z.object({ host: z.string(), port: z.coerce.number() }),
})
type AppConfig = z.infer<typeof schema>

const kConfig = token<ConfigHandle<AppConfig>>(Symbol('app.config'))

describe('base .config() builder', () => {
  it('binds the app config under the key the application declared, higher-precedence source winning', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const app = createApplication({ container })
      .config(schema, kConfig, c =>
        c
          .source(new InlineConfigProvider({ server: { host: 'primary', port: 3000 } }))
          .source(new InlineConfigProvider({ server: { host: 'fallback', port: 9999 } })),
      )
      .build()

    await app.ready()

    // No type argument: the key carries the type, which is the whole point of declaring it alongside the schema.
    const cfg = app.container.get(kConfig)
    expectTypeOf(cfg).toEqualTypeOf<ConfigHandle<AppConfig>>()
    expect(cfg.server.host).toBe('primary')
    expect(cfg.server.port).toBe(3000)
  })

  it('rejects a key that does not match the schema', () => {
    const kWrongShape = token<ConfigHandle<{ other: string }>>(Symbol('wrong.shape'))
    // The key names a config type the schema cannot produce.
    // @ts-expect-error - key and schema must agree
    createApplication().config(schema, kWrongShape)

    // Naming the config type instead of the handle is *not* rejected: the token brand relates the two
    // structurally, and the handle only adds `readonly`. Both keys resolve the same object, so this is a
    // laxness rather than a hole — but it means the guarantee here is "the shape matches", nothing more.
    const kUnwrapped = token<AppConfig>(Symbol('unwrapped'))
    createApplication().config(schema, kUnwrapped)
  })

  it('requires a key', () => {
    // @ts-expect-error - a schema without a key does not declare where the config is bound
    createApplication().config(schema)

    // @ts-expect-error - sources alone are not a configuration declaration
    createApplication().config(c => c.source(new InlineConfigProvider({ server: { host: 'x', port: 1 } })))
  })

  it('reflects new values after a config refresh', async () => {
    let data = { server: { host: 'before', port: 80 } }
    const mutable: ConfigProvider = {
      id: 'mutable',
      reloadable: true,
      load: ctx => new InlineConfigProvider(data).load(ctx),
    }

    const container = new CaffeineIoC({ decorators: false })
    const app = createApplication({ container })
      // Block-body callback with no return — the config type still comes from `schema`.
      .config(schema, kConfig, c => {
        c.source(mutable)
      })
      .build()

    await app.ready()

    const cfg = app.container.get(kConfig)
    expect(cfg.server.host).toBe('before')

    data = { server: { host: 'after', port: 443 } }
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(cfg.server.host).toBe('after')
    expect(cfg.server.port).toBe(443)
  })

  it('resolves Configuration from the class key, and it follows a refresh', async () => {
    let data = { server: { host: 'before', port: 80 } }
    const mutable: ConfigProvider = {
      id: 'mutable',
      reloadable: true,
      load: ctx => new InlineConfigProvider(data).load(ctx),
    }

    const container = new CaffeineIoC({ decorators: false })
    const app = createApplication({ container })
      .config(schema, kConfig, c => c.source(mutable))
      .build()

    await app.ready()

    const configuration = app.container.get(Configuration)
    expect(configuration).toBeInstanceOf(Configuration)
    expect(configuration.revision).toBe(0)
    expect(configuration.diagnostics.originOf('server.host')).toBeDefined()

    data = { server: { host: 'after', port: 443 } }
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    // Same instance throughout — it reads through to whatever the refresh published.
    expect(app.container.get(Configuration)).toBe(configuration)
    expect(configuration.revision).toBe(1)
    expect((configuration.snapshot() as AppConfig).server.host).toBe('after')
  })

  it('configures an application that declared no configuration of its own', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const builder = createApplication({ container })

    // A feature registers its slice the way every feature builder does, without the application declaring a root.
    const slice = defineFeatureConfig<{ size: number }>(builder.configDefinition, {
      namespace: ['widget'],
      schema: z.object({ size: z.coerce.number() }),
      defaults: { size: 1 },
    })
    builder.configDefinition.sources.add(new InlineConfigProvider({ widget: { size: 7 } }), ConfigPriority.USER)

    const app = builder.build()
    await app.ready()

    // Requiring a key did not make configuration opt-in: the slice resolved, and the tree is still reachable
    // for value injection through Configuration. What is absent is only a root binding.
    expect(slice.config.size).toBe(7)
    expect(app.container.get(Configuration).diagnostics.originOf('widget.size')).toBeDefined()
    expect(app.container.has(kConfig)).toBe(false)
  })

  it('picks up a source registered on the definition after .config() ran', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const builder = createApplication({ container }).config(schema, kConfig, c =>
      c.source(new InlineConfigProvider({ server: { host: 'first', port: 1 } })),
    )

    // The registry is live: this lands on the first bootstrap, not on some later refresh.
    builder.configDefinition.sources.add(
      new InlineConfigProvider({ server: { host: 'second', port: 2 } }),
      ConfigPriority.ENV,
    )

    const app = builder.build()
    await app.ready()

    expect(app.container.get(kConfig).server.host).toBe('second')
  })

  it('reads command-line arguments, above every other source', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const app = createApplication({ container })
      .config(schema, kConfig, c =>
        c
          .source(new InlineConfigProvider({ server: { host: 'from-code', port: 1 } }))
          .args({ argv: ['/usr/bin/node', '/app/main.js', '--server.host=from-args'] }),
      )
      .build()

    await app.run()

    expect(app.container.get(kConfig).server.host).toBe('from-args')
  })

  it('takes the host arguments when .args() names none', async () => {
    const original = process.argv
    process.argv = ['/usr/bin/node', '/app/main.js', '--server.host=from-process']

    try {
      const container = new CaffeineIoC({ decorators: false })
      const app = createApplication({ container })
        .config(schema, kConfig, c =>
          c.source(new InlineConfigProvider({ server: { host: 'from-code', port: 1 } })).args(),
        )
        .build()

      await app.run()

      expect(app.container.get(kConfig).server.host).toBe('from-process')
    } finally {
      process.argv = original
    }
  })
})
