import { CaffeineIoC, Keys, token, type NamedToken } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { ConfigHandle, ConfigProvider, ConfigSchema } from '../../config.js'
import { Configuration } from '../../configuration.js'
import { ConfigDefinition } from '../../definition.js'
import { CONFIG_REFRESH_LABEL, ConfigModule } from '../../integration/module.js'
import { InlineConfigProvider } from '../../providers/inline_provider.js'

const schema = z.object({
  http: z.object({ host: z.string(), port: z.coerce.number() }),
  db: z.object({ url: z.string() }),
})
type AppConfig = z.infer<typeof schema>

const APP_CONFIG = token<ConfigHandle<AppConfig>>(Symbol('app.config'))

function define<T>(
  configSchema: ConfigSchema<unknown>,
  provider: ConfigProvider,
  key?: NamedToken<ConfigHandle<T>>,
): ConfigDefinition {
  const definition = new ConfigDefinition(key)
  definition.schema = configSchema
  definition.sources.add(provider)
  return definition
}

function makeModule(data: Record<string, unknown>) {
  return ConfigModule<AppConfig>(define(schema, new InlineConfigProvider(data as never), APP_CONFIG))
}

describe('ConfigModule', () => {
  it('binds ConfigHandle to the provided token after init', async () => {
    const container = new CaffeineIoC()
    container.addModules(makeModule({ http: { host: 'localhost', port: 3000 }, db: { url: 'postgres://localhost' } }))
    await container.init()

    const config = container.get(APP_CONFIG)
    expect(config.http.host).toBe('localhost')
    expect(config.http.port).toBe(3000)
    expect(config.db.url).toBe('postgres://localhost')
  })

  it('binds no root key when none was given, and still binds the rest', async () => {
    const container = new CaffeineIoC()
    container.addModules(
      ConfigModule<AppConfig>(
        define(schema, new InlineConfigProvider({ http: { host: 'h', port: 80 }, db: { url: 'u' } } as never)),
      ),
    )
    await container.init()

    // Nothing to resolve the handle by — an application that declared no configuration of its own — but the
    // configuration itself resolved, and value injection still reads it.
    expect(container.has(APP_CONFIG)).toBe(false)
    expect(container.get(Configuration).diagnostics.originOf('http.host')).toBeDefined()
    expect(container.has(Keys.kValuesProvider)).toBe(true)
  })

  it('ConfigHandle is typed and function-free', async () => {
    const container = new CaffeineIoC()
    container.addModules(makeModule({ http: { host: 'h', port: 80 }, db: { url: 'u' } }))
    await container.init()

    const config = container.get(APP_CONFIG)
    const ownMethods = Object.keys(config).filter(k => typeof (config as never)[k] === 'function')
    expect(ownMethods).toHaveLength(0)
  })

  it('two ConfigModule registrations refresh independently', async () => {
    const dbSchema = z.object({ db: z.object({ url: z.string() }) })
    type DBConfig = z.infer<typeof dbSchema>
    const DB_TOKEN = token<ConfigHandle<DBConfig>>(Symbol('db.config'))

    let appData = { http: { host: 'app', port: 80 }, db: { url: 'u' } }
    let dbData = { db: { url: 'postgres://a' } }

    const appProvider: ConfigProvider = {
      id: 'app',
      reloadable: true,
      load: async () => new InlineConfigProvider(appData as never).load({ profiles: ['default'] }),
    }
    const dbProvider: ConfigProvider = {
      id: 'db',
      reloadable: true,
      load: async () => new InlineConfigProvider(dbData as never).load({ profiles: ['default'] }),
    }

    const container = new CaffeineIoC()
    container.addModules(
      ConfigModule<AppConfig>(define(schema, appProvider, APP_CONFIG)),
      ConfigModule<DBConfig>(define(dbSchema, dbProvider, DB_TOKEN)),
    )
    await container.init()

    const appConfig = container.get(APP_CONFIG)
    const dbConfig = container.get(DB_TOKEN)

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
        return p.load({ profiles: ['default'] })
      },
    }

    const container = new CaffeineIoC()
    container.addModules(ConfigModule<AppConfig>(define(schema, mutableProvider, APP_CONFIG)))
    await container.init()

    const config = container.get(APP_CONFIG)
    expect(config.http.host).toBe('before')

    data = { http: { host: 'after', port: 443 }, db: { url: 'u' } }
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(config.http.host).toBe('after')
    expect(config.http.port).toBe(443)
  })
})
