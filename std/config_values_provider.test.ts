import { $i, CaffeineIoC, Injectable, Scopes, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { CONFIG_REFRESH_LABEL, InlineConfigSource, type ConfigSource } from './config/index.js'
import { createApplication, newConfiguration } from './index.js'
import { $t } from './schema/t.js'

const schema = $t.Object({
  database: $t.Object({
    host: $t.String(),
    port: $t.Number(),
  }),
})

type AppConfig = { database: { host: string; port: number } }

const kConfig = token<AppConfig>(Symbol('app.config'))

function appWith(...sources: Array<{ provider: ConfigSource }>) {
  const container = new CaffeineIoC({ decorators: false })
  const configBuilder = newConfiguration(schema, kConfig)
  for (const { provider } of sources) {
    configBuilder.source(provider)
  }
  const builder = createApplication({ container, config: configBuilder.build() })

  return { builder, container }
}

describe('configuration as the DI values provider', () => {
  it('injects a value selected by function', async () => {
    @Injectable([$i.value<AppConfig, string>(c => c.database.host)])
    class Repository {
      constructor(readonly host: string) {}
    }

    const { builder, container } = appWith({
      provider: new InlineConfigSource({ database: { host: 'db.local', port: 5432 } }),
    })
    container.bind(Repository, t => t.toSelf())

    await builder.ready()

    expect(container.get(Repository).host).toBe('db.local')
  })

  it('injects a value selected by dot-path, and honours a default', async () => {
    @Injectable([
      $i.value<AppConfig, number>('database.port'),
      $i.value<AppConfig, string>('database.missing', 'fallback'),
    ])
    class Repository {
      constructor(
        readonly port: number,
        readonly missing: string,
      ) {}
    }

    const { builder, container } = appWith({
      provider: new InlineConfigSource({ database: { host: 'h', port: 5432 } }),
    })
    container.bind(Repository, t => t.toSelf())

    await builder.ready()

    const repository = container.get(Repository)
    expect(repository.port).toBe(5432)
    expect(repository.missing).toBe('fallback')
  })

  // The handle is live and the config resolver calls the binding's factory on every read, so a transient
  // resolved after a refresh sees the new value without anything having been rebound.
  it('follows a refresh', async () => {
    @Injectable([$i.value<AppConfig, string>(c => c.database.host)])
    class Holder {
      constructor(readonly host: string) {}
    }

    let database = { host: 'first', port: 5432 }
    const changing: ConfigSource = { name: 'test', live: true, load: () => [{ name: 'test', data: { database } }] }

    const { builder, container } = appWith({ provider: changing })
    container.bind(Holder, t => t.toSelf().lifetime(Scopes.TRANSIENT))

    await builder.ready()

    expect(container.get(Holder).host).toBe('first')

    database = { host: 'second', port: 5432 }
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(container.get(kConfig).database.host).toBe('second')
    expect(container.get(Holder).host).toBe('second')
  })

  it('leaves an application-supplied values provider alone', async () => {
    @Injectable([$i.value<{ own: string }, string>(c => c.own)])
    class Holder {
      constructor(readonly own: string) {}
    }

    const { builder, container } = appWith({
      provider: new InlineConfigSource({ database: { host: 'h', port: 1 } }),
    })
    container.bindValuesProvider<{ own: string }>(t => t.toValue({ own: 'mine' }))
    container.bind(Holder, t => t.toSelf())

    await builder.ready()

    expect(container.get(Holder).own).toBe('mine')
  })
})
