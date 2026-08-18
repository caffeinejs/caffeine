import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CONFIG_REFRESH_LABEL, InlineProvider, type ConfigHandle, type ConfigProvider } from './config/index.js'
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
        .source(new InlineProvider({ server: { host: 'primary', port: 3000 } }))
        .source(new InlineProvider({ server: { host: 'fallback', port: 9999 } })))
      .build()

    await app.ready()

    const cfg = app.container.get<ConfigHandle<AppConfig>>(kAppConfig)
    expect(cfg.server.host).toBe('primary')
    expect(cfg.server.port).toBe(3000)
  })

  it('reflects new values after a config refresh', async () => {
    let data = { server: { host: 'before', port: 80 } }
    const mutable: ConfigProvider = { id: 'mutable', load: ctx => new InlineProvider(data).load(ctx) }

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
})
