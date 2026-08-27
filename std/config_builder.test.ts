import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  CONFIG_REFRESH_LABEL,
  ConfigPriority,
  InlineConfigProvider,
  type ConfigHandle,
  type ConfigProvider,
} from './config/index.js'
import { createApplication, kAppConfig } from './index.js'

const schema = z.object({
  server: z.object({ host: z.string(), port: z.coerce.number() }),
})
type AppConfig = z.infer<typeof schema>

describe('base .config() builder', () => {
  it('binds the app config under kAppConfig, higher-precedence source winning', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const app = createApplication({ container })
      .config(schema, c => c
        .source(new InlineConfigProvider({ server: { host: 'primary', port: 3000 } }))
        .source(new InlineConfigProvider({ server: { host: 'fallback', port: 9999 } })))
      .build()

    await app.ready()

    const cfg = app.container.get<ConfigHandle<AppConfig>>(kAppConfig)
    expect(cfg.server.host).toBe('primary')
    expect(cfg.server.port).toBe(3000)
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
      .config(schema, c => { c.source(mutable) })
      .build()

    await app.ready()

    const cfg = app.container.get<ConfigHandle<AppConfig>>(kAppConfig)
    expect(cfg.server.host).toBe('before')

    data = { server: { host: 'after', port: 443 } }
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(cfg.server.host).toBe('after')
    expect(cfg.server.port).toBe(443)
  })

  it('binds a config even when the application never declared one', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const app = createApplication({ container }).build()

    await app.ready()

    // Configuration is unconditional now — features read their slices from this tree either way.
    expect(app.container.has(kAppConfig)).toBe(true)
  })

  it('registers sources with no schema at all', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const app = createApplication({ container })
      .config(c => c.source(new InlineConfigProvider({ anything: { at: 'all' } })))
      .build()

    await app.ready()

    expect(app.container.get<{ anything: { at: string } }>(kAppConfig).anything.at).toBe('all')
  })

  it('picks up a source registered on the definition after .config() ran', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const builder = createApplication({ container })
      .config(schema, c => c.source(new InlineConfigProvider({ server: { host: 'first', port: 1 } })))

    // The registry is live: this lands on the first bootstrap, not on some later refresh.
    builder.configDefinition.sources.add(
      new InlineConfigProvider({ server: { host: 'second', port: 2 } }),
      ConfigPriority.ENV,
    )

    const app = builder.build()
    await app.ready()

    expect(app.container.get<ConfigHandle<AppConfig>>(kAppConfig).server.host).toBe('second')
  })

  it('reads command-line arguments, above every other source', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const app = createApplication({ container })
      .config(schema, c => c
        .source(new InlineConfigProvider({ server: { host: 'from-code', port: 1 } }))
        .args({ argv: ['/usr/bin/node', '/app/main.js', '--server.host=from-args'] }))
      .build()

    await app.run()

    expect(app.container.get<ConfigHandle<AppConfig>>(kAppConfig).server.host).toBe('from-args')
  })

  it('takes the host arguments when .args() names none', async () => {
    const original = process.argv
    process.argv = ['/usr/bin/node', '/app/main.js', '--server.host=from-process']

    try {
      const container = new CaffeineIoC({ decorators: false })
      const app = createApplication({ container })
        .config(schema, c => c
          .source(new InlineConfigProvider({ server: { host: 'from-code', port: 1 } }))
          .args())
        .build()

      await app.run()

      expect(app.container.get<ConfigHandle<AppConfig>>(kAppConfig).server.host).toBe('from-process')
    } finally {
      process.argv = original
    }
  })
})
