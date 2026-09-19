import { $i, CaffeineIoC, Injectable, Keys, Scopes, token, type NamedToken } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { $t } from '../../../schema/t.js'
import { CONFIG_REFRESH_LABEL, ConfigModule } from '../../integration/module.js'
import { loadConfig } from '../../load.js'
import { REDACTED } from '../../redact.js'
import { ConfigStore } from '../../store.js'
import type { ConfigSchema, ConfigSource, InferConfig } from '../../types.js'

const schema = z.object({
  http: z.object({ host: z.string(), port: z.coerce.number() }),
  db: z.object({ url: z.string() }),
})
type AppConfig = InferConfig<typeof schema>

const kConfig = token<AppConfig>(Symbol('app.config'))
const kStore = token<ConfigStore<AppConfig>>(Symbol('app.config.store'))

/** A live source over data the test replaces. */
function remote(initial: Record<string, unknown>, name = 'remote') {
  const state = { data: initial }
  const source: ConfigSource = { name, live: true, load: () => [{ name, data: state.data as never }] }
  return { source, state }
}

async function containerWith<T>(
  schemaOf: ConfigSchema<T>,
  source: ConfigSource,
  keys: { key?: NamedToken<T>; storeKey?: NamedToken<ConfigStore<T>> } = {},
) {
  const store = await loadConfig<T>(
    { schema: schemaOf, key: keys.key, storeKey: keys.storeKey, sources: [source], loadTimeoutMs: 30_000 },
    { start: false },
  )
  const container = new CaffeineIoC({ decorators: false })
  container.addModules(ConfigModule(store))
  await container.init()
  return { container, store }
}

const data = { http: { host: 'localhost', port: '3000' }, db: { url: 'postgres://localhost' } }

describe('ConfigModule', () => {
  it('binds the live config object under the key, and the store under its key and its class', async () => {
    const { container, store } = await containerWith(schema, remote(data).source, { key: kConfig, storeKey: kStore })

    expect(container.get(kConfig)).toBe(store.live)
    expect(container.get(kConfig).http.port).toBe(3000)
    expect(container.get(kStore)).toBe(store)
    expect(container.get(ConfigStore)).toBe(store)
  })

  it('binds no application key when none was given, and still binds the rest', async () => {
    const { container, store } = await containerWith(schema, remote(data).source)

    expect(container.has(kConfig)).toBe(false)
    expect(container.get(ConfigStore)).toBe(store)
    expect(container.has(Keys.kValuesProvider)).toBe(true)
  })

  // The values provider is read when a consumer is built, so a transient built after a reload sees the new value.
  it('lets $i.value read the snapshot current when the consumer is built', async () => {
    @Injectable([$i.value<AppConfig, string>(c => c.http.host)])
    class Client {
      constructor(readonly host: string) {}
    }

    const { source, state } = remote(data)
    const store = await loadConfig<AppConfig>(
      { schema, key: kConfig, storeKey: undefined, sources: [source], loadTimeoutMs: 30_000 },
      { start: false },
    )
    const container = new CaffeineIoC({ decorators: false })
    container.addModules(ConfigModule(store))
    container.bind(Client, t => t.toSelf().lifetime(Scopes.TRANSIENT))
    await container.init()

    expect(container.get(Client).host).toBe('localhost')

    state.data = { ...data, http: { host: 'moved', port: '1' } }
    await store.reload()

    expect(container.get(Client).host).toBe('moved')
  })

  it('reloads the live sources when the container refreshes the configuration label', async () => {
    const { source, state } = remote(data)
    const { container } = await containerWith(schema, source, { key: kConfig })
    const config = container.get(kConfig)

    state.data = { http: { host: 'after', port: '443' }, db: { url: 'u' } }
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(config.http.host).toBe('after')
    expect(config.http.port).toBe(443)
  })

  it('makes the refresh reject when the reload was rejected, and changes nothing', async () => {
    const { source, state } = remote(data)
    const { container } = await containerWith(schema, source, { key: kConfig })

    state.data = { http: { host: 'after', port: 'not-a-number' }, db: { url: 'u' } }

    await expect(container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)).rejects.toMatchObject({
      name: 'ErrConfigValidation',
    })
    expect(container.get(kConfig).http.host).toBe('localhost')
  })

  // Whoever refreshes may log what the refresh threw, and a codec's parser quotes the text it rejected.
  it('makes the refresh reject without the text of a secret', async () => {
    const secret = $t.Object({ credentials: $t.Secret($t.JSON($t.Object({ key: $t.String() }))) })
    const { source, state } = remote({ credentials: '{"key":"k"}' })
    const { container } = await containerWith(secret, source)

    state.data = { credentials: 'hunter2' }
    const error = await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol).catch((e: unknown) => e)

    expect(error).toMatchObject({ name: 'ErrConfigValidation', issues: [{ path: 'credentials', message: REDACTED }] })
    expect((error as Error).message).not.toContain('hunter2')
  })

  it('makes the refresh reject when a live source failed', async () => {
    let loads = 0
    const failing: ConfigSource = {
      name: 'remote',
      live: true,
      load: () => {
        if (loads++ > 0) {
          throw new Error('connection reset')
        }
        return [{ name: 'remote', data: data as never }]
      },
    }
    const { container } = await containerWith(schema, failing, { key: kConfig })

    await expect(container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)).rejects.toMatchObject({
      code: 'ERR_CONFIG_SOURCE',
    })
    expect(container.get(kConfig).http.host).toBe('localhost')
  })

  it('refreshes two configurations in one container independently', async () => {
    const dbSchema = z.object({ db: z.object({ url: z.string() }) })
    type DBConfig = InferConfig<typeof dbSchema>
    const kDB = token<DBConfig>(Symbol('db.config'))

    const app = remote(data, 'app')
    const db = remote({ db: { url: 'postgres://a' } }, 'db')
    const appStore = await loadConfig<AppConfig>(
      { schema, key: kConfig, storeKey: undefined, sources: [app.source], loadTimeoutMs: 30_000 },
      { start: false },
    )
    const dbStore = await loadConfig<DBConfig>(
      { schema: dbSchema, key: kDB, storeKey: undefined, sources: [db.source], loadTimeoutMs: 30_000 },
      { start: false },
    )
    const container = new CaffeineIoC({ decorators: false })
    container.addModules(ConfigModule(appStore), ConfigModule(dbStore))
    await container.init()

    app.state.data = { http: { host: 'refreshed', port: '443' }, db: { url: 'u' } }
    db.state.data = { db: { url: 'postgres://b' } }
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(container.get(kConfig).http.host).toBe('refreshed')
    expect(container.get(kDB).db.url).toBe('postgres://b')
  })

  it('closes the store when the container is disposed', async () => {
    let closed = 0
    const source: ConfigSource = { ...remote(data).source, close: () => void closed++ }
    const { container } = await containerWith(schema, source)

    await container.dispose()

    expect(closed).toBe(1)
  })
})
