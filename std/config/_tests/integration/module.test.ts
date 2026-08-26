import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ConfigHandle } from '../../accessor.js'
import { CONFIG_REFRESH_LABEL, ConfigModule } from '../../integration/module.js'
import { InlineConfigProvider } from '../../providers/inline_provider.js'
import type { ConfigProvider } from '../../types.js'

const schema = z.object({
  http: z.object({ host: z.string(), port: z.coerce.number() }),
  db: z.object({ url: z.string() }),
})
type AppConfig = z.infer<typeof schema>

const APP_CONFIG = Symbol('app.config')

function makeModule(data: Record<string, unknown>) {
  return ConfigModule<AppConfig>({
    token: APP_CONFIG,
    schema,
    providers: [new InlineConfigProvider(data as never)],
  })
}

describe('ConfigModule', () => {
  it('binds ConfigHandle to the provided token after init', async () => {
    const container = new CaffeineIoC()
    container.addModules(makeModule({ http: { host: 'localhost', port: 3000 }, db: { url: 'postgres://localhost' } }))
    await container.init()

    const config = container.get<ConfigHandle<AppConfig>>(APP_CONFIG as symbol)
    expect(config.http.host).toBe('localhost')
    expect(config.http.port).toBe(3000)
    expect(config.db.url).toBe('postgres://localhost')
  })

  it('ConfigHandle is typed and function-free', async () => {
    const container = new CaffeineIoC()
    container.addModules(makeModule({ http: { host: 'h', port: 80 }, db: { url: 'u' } }))
    await container.init()

    const config = container.get<ConfigHandle<AppConfig>>(APP_CONFIG as symbol)
    const ownMethods = Object.keys(config).filter(k => typeof (config as never)[k] === 'function')
    expect(ownMethods).toHaveLength(0)
  })

  it('two ConfigModule registrations refresh independently', async () => {
    const DB_TOKEN = Symbol('db.config')
    const dbSchema = z.object({ db: z.object({ url: z.string() }) })
    type DBConfig = z.infer<typeof dbSchema>

    let appData = { http: { host: 'app', port: 80 }, db: { url: 'u' } }
    let dbData = { db: { url: 'postgres://a' } }

    const appProvider: ConfigProvider = { id: 'app', reloadable: true, load: async () => new InlineConfigProvider(appData as never).load({ app: 'test', profiles: ['default'] }) }
    const dbProvider: ConfigProvider = { id: 'db', reloadable: true, load: async () => new InlineConfigProvider(dbData as never).load({ app: 'test', profiles: ['default'] }) }

    const container = new CaffeineIoC()
    container.addModules(
      ConfigModule<AppConfig>({ token: APP_CONFIG, schema, providers: [appProvider] }),
      ConfigModule<DBConfig>({ token: DB_TOKEN, schema: dbSchema, providers: [dbProvider] }),
    )
    await container.init()

    const appConfig = container.get<ConfigHandle<AppConfig>>(APP_CONFIG as symbol)
    const dbConfig = container.get<ConfigHandle<DBConfig>>(DB_TOKEN as symbol)

    expect(appConfig.http.host).toBe('app')
    expect(dbConfig.db.url).toBe('postgres://a')

    appData = { http: { host: 'refreshed', port: 443 }, db: { url: 'u' } }
    dbData = { db: { url: 'postgres://b' } }
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(appConfig.http.host).toBe('refreshed')
    expect(dbConfig.db.url).toBe('postgres://b')
  })

  it('live proxy reflects values after manual shard refresh', async () => {
    let data = { http: { host: 'before', port: 80 }, db: { url: 'u' } }

    const mutableProvider: ConfigProvider = {
      id: 'mutable',
      reloadable: true,
      load: async () => {
        const { InlineConfigProvider } = await import('../../providers/inline_provider.js')
        const p = new InlineConfigProvider(data as never)
        return p.load({ app: 'test', profiles: ['default'] })
      },
    }

    const container = new CaffeineIoC()
    container.addModules(
      ConfigModule<AppConfig>({ token: APP_CONFIG, schema, providers: [mutableProvider] }),
    )
    await container.init()

    const config = container.get<ConfigHandle<AppConfig>>(APP_CONFIG as symbol)
    expect(config.http.host).toBe('before')

    data = { http: { host: 'after', port: 443 }, db: { url: 'u' } }
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(config.http.host).toBe('after')
    expect(config.http.port).toBe(443)
  })
})
