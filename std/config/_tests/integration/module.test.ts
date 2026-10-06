import { $i, CaffeineIoC, ErrDuplicateBinding, Scopes, type Provider } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { $t } from '../../../schema/t.js'
import { CONFIG_REFRESH_LABEL, ConfigModule } from '../../integration/module.js'
import { loadConfig } from '../../load.js'
import { ConfigStore } from '../../store.js'
import { testTokens } from '../../tokens.testkit.js'
import type { ConfigDefinition, ConfigSchema, ConfigSource, InferConfig } from '../../types.js'

const schema = z.object({
  http: z.object({ host: z.string(), port: z.coerce.number() }),
  db: z.object({ url: z.string() }),
})
type AppConfig = InferConfig<typeof schema>

/** A live source over data the test replaces. */
function remote(initial: Record<string, unknown>, name = 'remote') {
  const state = { data: initial }
  const source: ConfigSource = { name, live: true, load: () => [{ name, data: state.data as never }] }
  return { source, state }
}

function definitionOf<T>(schemaOf: ConfigSchema<T>, ...sources: ConfigSource[]): ConfigDefinition<T> {
  return { schema: schemaOf, ...testTokens<T>(), sources, loadTimeoutMs: 30_000 }
}

async function containerWith<T>(definition: ConfigDefinition<T>, bind?: (container: CaffeineIoC) => void) {
  const store = await loadConfig<T>(definition, { start: false })
  const container = new CaffeineIoC({ decorators: false })
  container.addModules(ConfigModule(store))
  bind?.(container)
  await container.init()
  return { container, store }
}

const data = { http: { host: 'localhost', port: '3000' }, db: { url: 'postgres://localhost' } }
const moved = { ...data, http: { host: 'moved', port: '1' } }

describe('ConfigModule', () => {
  it('binds the start-up snapshot under the config token, a provider under the live token, and the store under its token and class', async () => {
    const definition = definitionOf(schema, remote(data).source)
    const { container, store } = await containerWith(definition)

    expect(container.get(definition.configToken)).toBe(store.current)
    expect(container.get(definition.configToken).http.port).toBe(3000)
    expect(container.get(definition.liveConfigToken).get()).toBe(store.current)
    expect(container.get(definition.storeToken)).toBe(store)
    expect(container.get(ConfigStore)).toBe(store)
  })

  // The config token is the configuration the application started with: every consumer, whenever it is built,
  // reads the same revision. Following reloads is what the live token is for.
  it('keeps the config token at the start-up snapshot after a reload, while the live token follows it', async () => {
    const { source, state } = remote(data)
    const definition = definitionOf(schema, source)
    const { container, store } = await containerWith(definition)
    const startup = store.current

    state.data = moved
    await store.reload()

    expect(container.get(definition.configToken)).toBe(startup)
    expect(container.get(definition.configToken).http.host).toBe('localhost')
    expect(container.get(definition.liveConfigToken).get().http.host).toBe('moved')
  })

  // The reason the live token is a provider: a singleton is built once and still reads the newest revision.
  it('lets a singleton built once read the newest revision through the live token', async () => {
    const { source, state } = remote(data)
    const definition = definitionOf(schema, source)

    class Client {
      constructor(readonly config: Provider<AppConfig>) {}
    }

    const { container, store } = await containerWith(definition, c =>
      c.bind(Client, t => t.toSelf([definition.liveConfigToken]).lifetime(Scopes.SINGLETON)),
    )
    const client = container.get(Client)

    state.data = moved
    await store.reload()

    expect(container.get(Client)).toBe(client)
    expect(client.config.get().http.host).toBe('moved')
  })

  it('binds the start-up snapshot as the values, so $i.config never sees a reload', async () => {
    const { source, state } = remote(data)

    class Client {
      constructor(readonly host: string) {}
    }

    const { container, store } = await containerWith(definitionOf(schema, source), c =>
      c.bind(Client, t => t.toSelf([$i.config<AppConfig, string>(c => c.http.host)]).lifetime(Scopes.TRANSIENT)),
    )

    expect(container.values).toBe(store.current)

    state.data = moved
    await store.reload()

    expect(container.get(Client).host).toBe('localhost')
  })

  it('binds the live provider as the scoped config, so $i.liveConfig reads the newest revision', async () => {
    const { source, state } = remote(data)

    class Client {
      constructor(readonly host: Provider<string>) {}
    }

    const { container, store } = await containerWith(definitionOf(schema, source), c =>
      c.bind(Client, t => t.toSelf([$i.liveConfig<AppConfig, string>(c => c.http.host)])),
    )
    const client = container.get(Client)

    state.data = moved
    await store.reload()

    expect(client.host.get()).toBe('moved')
  })

  it('leaves values and a scoped config the application bound itself alone', async () => {
    const values = { mine: true }
    const scoped: Provider<unknown> = { get: () => values }

    const { container } = await containerWith(definitionOf(schema, remote(data).source), c =>
      c.bindConfig(values).bindScopedConfig(scoped),
    )

    expect(container.values).toBe(values)
    expect(container.scopedConfig).toBe(scoped)
  })

  it('reloads the live sources when the container refreshes the configuration label', async () => {
    const { source, state } = remote(data)
    const definition = definitionOf(schema, source)
    const { container } = await containerWith(definition)
    const live = container.get(definition.liveConfigToken)

    state.data = { http: { host: 'after', port: '443' }, db: { url: 'u' } }
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(live.get().http.host).toBe('after')
    expect(live.get().http.port).toBe(443)
  })

  it('makes the refresh reject when the reload was rejected, and changes nothing', async () => {
    const { source, state } = remote(data)
    const definition = definitionOf(schema, source)
    const { container } = await containerWith(definition)

    state.data = { http: { host: 'after', port: 'not-a-number' }, db: { url: 'u' } }

    await expect(container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)).rejects.toMatchObject({
      name: 'ErrConfigValidation',
    })
    expect(container.get(definition.liveConfigToken).get().http.host).toBe('localhost')
  })

  // Whoever refreshes may log what the refresh threw, and a codec's parser quotes the text it rejected.
  it('makes the refresh reject without the text a codec could not parse', async () => {
    const json = $t.Object({ credentials: $t.JSON($t.Object({ key: $t.String() })) })
    const { source, state } = remote({ credentials: '{"key":"k"}' })
    const { container } = await containerWith(definitionOf(json, source))

    state.data = { credentials: 'hunter2' }
    const error = await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol).catch((e: unknown) => e)

    expect(error).toMatchObject({
      name: 'ErrConfigValidation',
      issues: [{ path: 'credentials', message: 'The value is not valid JSON' }],
    })
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
    const definition = definitionOf(schema, failing)
    const { container } = await containerWith(definition)

    await expect(container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)).rejects.toMatchObject({
      code: 'ERR_CONFIG_SOURCE',
    })
    expect(container.get(definition.liveConfigToken).get().http.host).toBe('localhost')
  })

  // The configuration never depended on an optional source: start-up goes on without it, and so does a refresh. A
  // refresh reported as failed, although it applied everything else, would be retried by whoever asked for it.
  it('lets the refresh stand when only an optional source failed', async () => {
    const app = remote(data, 'app')
    const flaky: ConfigSource = {
      name: 'flaky',
      live: true,
      optional: true,
      load: () => {
        throw new Error('connection reset')
      },
    }
    const definition = definitionOf(schema, app.source, flaky)
    const { container, store } = await containerWith(definition)

    app.state.data = { ...data, http: { host: 'after', port: '443' } }
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(container.get(definition.liveConfigToken).get().http.host).toBe('after')
    expect((await store.reload()).failures).toEqual([
      { source: 'flaky', optional: true, error: expect.objectContaining({ code: 'ERR_CONFIG_SOURCE' }) },
    ])
  })

  // The framework finds the store by its class, so a second store there could only be a silent replacement.
  it('refuses a second configuration in one container', async () => {
    const appStore = await loadConfig(definitionOf(schema, remote(data, 'app').source), { start: false })
    const dbStore = await loadConfig(definitionOf(schema, remote(data, 'db').source), { start: false })
    const container = new CaffeineIoC({ decorators: false })
    container.addModules(ConfigModule(appStore), ConfigModule(dbStore))

    await expect(container.init()).rejects.toThrow(ErrDuplicateBinding)
  })

  it('closes the store when the container is disposed', async () => {
    let closed = 0
    const source: ConfigSource = { ...remote(data).source, close: () => void closed++ }
    const { container } = await containerWith(definitionOf(schema, source))

    await container.dispose()

    expect(closed).toBe(1)
  })
})
