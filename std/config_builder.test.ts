import { CaffeineIoC, token, type NamedToken } from '@caffeinejs/di'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'

import {
  CONFIG_REFRESH_LABEL,
  ConfigStore,
  InlineConfigSource,
  type ConfigSource,
  type InferConfig,
} from './config/index.js'
import { newConfiguration } from './configuration.js'
import { createApplication } from './index.js'

const schema = z.object({
  server: z.object({ host: z.string(), port: z.coerce.number() }),
})
type AppConfig = InferConfig<typeof schema>

const kConfig = token<AppConfig>(Symbol('app.config'))
const kStore = token<ConfigStore<AppConfig>>(Symbol('app.config.store'))

/** A live source over data the test replaces. */
function remote(initial: { server: { host: string; port: number } }) {
  const state = { data: initial }
  const source: ConfigSource = { name: 'remote', live: true, load: () => [{ name: 'remote', data: state.data }] }
  return { source, state }
}

describe('newConfiguration', () => {
  it('binds the application config under the key the application declared, a later source winning', async () => {
    const container = new CaffeineIoC({ decorators: false })
    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ server: { host: 'fallback', port: 9999 } }, 'fallback'))
      .source(new InlineConfigSource({ server: { host: 'primary', port: 3000 } }, 'primary'))
      .build()
    const app = createApplication({ container, config: conf })

    await app.ready()

    // No type argument: the key carries the type, which is the point of declaring it beside the schema.
    const config = app.container.get(kConfig)
    expectTypeOf(config).toEqualTypeOf<AppConfig>()
    expect(config.server.host).toBe('primary')
    expect(config.server.port).toBe(3000)
  })

  it('rejects a key that does not match the schema', () => {
    const kWrongShape = token<{ other: string }>(Symbol('wrong.shape'))
    // @ts-expect-error - key and schema must agree
    newConfiguration(schema, kWrongShape)
  })

  // A key naming more than the schema describes is accurate for the keys the schema passes through, and it is how an
  // application types a block without redeclaring its shape.
  it('accepts a key naming a wider type than the schema describes', () => {
    type Wider = AppConfig & { readonly caffeine: { readonly name: string } }
    const kWider = token<Wider>(Symbol('wider'))
    const conf = newConfiguration(schema, kWider).build()

    expectTypeOf(conf.key).toEqualTypeOf<NamedToken<Wider> | undefined>()
  })

  it('requires a key', () => {
    // @ts-expect-error - a schema without a key does not declare where the config is bound
    newConfiguration(schema)

    // @ts-expect-error - sources alone are not a configuration declaration
    newConfiguration(c => c.source(new InlineConfigSource({ server: { host: 'x', port: 1 } })))
  })

  it('binds the store under the key named for it', async () => {
    const conf = newConfiguration(schema, kConfig, kStore)
      .source(new InlineConfigSource({ server: { host: 'h', port: 1 } }))
      .build()
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf })

    await app.ready()

    const store = app.container.get(kStore)
    expectTypeOf(store).toEqualTypeOf<ConfigStore<AppConfig>>()
    expect(store).toBe(app.container.get(ConfigStore))
    expect(store.live).toBe(app.container.get(kConfig))
  })

  // The sources are data once built: nothing added afterwards could be seen by a load that already happened.
  it('fixes the definition at build()', () => {
    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ server: { host: 'h', port: 1 } }))
      .build()

    expect(Object.isFrozen(conf)).toBe(true)
    expect(Object.isFrozen(conf.sources)).toBe(true)
    expect(() => (conf.sources as ConfigSource[]).push(new InlineConfigSource({}, 'late'))).toThrow(TypeError)
  })

  it('bounds each load by 30 seconds unless told otherwise', () => {
    expect(newConfiguration(schema, kConfig).build().loadTimeoutMs).toBe(30_000)
    expect(newConfiguration(schema, kConfig).loadTimeout('5s').build().loadTimeoutMs).toBe(5_000)
    expect(newConfiguration(schema, kConfig).loadTimeout(250).build().loadTimeoutMs).toBe(250)
  })

  it('reflects new values after a config refresh', async () => {
    const { source, state } = remote({ server: { host: 'before', port: 80 } })
    const conf = newConfiguration(schema, kConfig).source(source).build()
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf })

    await app.ready()

    const config = app.container.get(kConfig)
    expect(config.server.host).toBe('before')

    state.data = { server: { host: 'after', port: 443 } }
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(config.server.host).toBe('after')
    expect(config.server.port).toBe(443)
  })

  it('binds the store under its class, and it follows a reload', async () => {
    const { source, state } = remote({ server: { host: 'before', port: 80 } })
    const conf = newConfiguration(schema, kConfig).source(source).build()
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf })

    await app.ready()

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

    await app.ready()

    expect(app.container.get(ConfigStore).current).toEqual({})
    expect(app.container.has(kConfig)).toBe(false)
  })

  it('reads command-line arguments, above every other source', async () => {
    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ server: { host: 'from-code', port: 1 } }))
      .args({ argv: ['/usr/bin/node', '/app/main.js', '--server.host=from-args'] })
      .build()
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf })

    await app.run()

    expect(app.container.get(kConfig).server.host).toBe('from-args')
    await app.close()
  })

  it('takes the host arguments when .args() names none', async () => {
    const original = process.argv
    process.argv = ['/usr/bin/node', '/app/main.js', '--server.host=from-process']

    try {
      const conf = newConfiguration(schema, kConfig)
        .source(new InlineConfigSource({ server: { host: 'from-code', port: 1 } }))
        .args()
        .build()
      const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf })

      await app.run()

      expect(app.container.get(kConfig).server.host).toBe('from-process')
      await app.close()
    } finally {
      process.argv = original
    }
  })
})
