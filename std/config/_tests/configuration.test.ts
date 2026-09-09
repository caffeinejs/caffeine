import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { $t } from '../../schema/t.js'
import type { ConfigHandle } from '../accessor.js'
import { Configuration } from '../configuration.js'
import { ConfigDefinition } from '../definition.js'
import { CONFIG_REFRESH_LABEL, ConfigModule } from '../integration/module.js'
import { MutableConfigProvider } from '../providers/mutable_provider.js'
import { ConfigPriority } from '../sources.js'

const APP_CONFIG = token<ConfigHandle<App>>(Symbol('app.config'))

interface App {
  server: { port: number }
}

const schema = $t.Object({
  server: $t.Object({ port: $t.Number({ default: 0 }) }, { default: {} }),
})

async function setup(): Promise<{
  container: CaffeineIoC
  configuration: Configuration<App>
  mutable: MutableConfigProvider
}> {
  const definition = new ConfigDefinition(APP_CONFIG)
  const mutable = new MutableConfigProvider('test')
  mutable.set('server.port', 3000)
  definition.sources.add(mutable, ConfigPriority.ENV)
  definition.schema = schema

  const container = new CaffeineIoC({ decorators: false })
  container.addModules(ConfigModule(definition))
  await container.init()

  return { container, configuration: container.get(Configuration) as Configuration<App>, mutable }
}

describe('Configuration', () => {
  it('exposes the same config object bound under the application token', async () => {
    const { container, configuration } = await setup()
    expect(configuration.config).toBe(container.get(APP_CONFIG))
  })

  it('follows a refresh through .config', async () => {
    const { container, configuration, mutable } = await setup()

    expect(configuration.config.server.port).toBe(3000)

    mutable.set('server.port', 8080)
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(configuration.config.server.port).toBe(8080)
  })

  it('detaches a snapshot from later refreshes', async () => {
    const { container, configuration, mutable } = await setup()

    const taken = configuration.snapshot()
    expect(taken.server.port).toBe(3000)

    mutable.set('server.port', 8080)
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    // A refresh replaces the tree rather than mutating it, so what was taken keeps the values it had. This is
    // the primitive a request-scoped snapshot is built from.
    expect(taken.server.port).toBe(3000)
    expect(configuration.snapshot().server.port).toBe(8080)
  })

  it('hands back a plain frozen object, not a proxy', async () => {
    const { configuration } = await setup()
    const taken = configuration.snapshot()

    expect(Object.isFrozen(taken)).toBe(true)
    expect(Object.isFrozen(taken.server)).toBe(true)
    // Plain property access: the fastest read available, which is why a snapshot is worth having at all.
    expect(taken.server).toBe(taken.server)
    expect(() => {
      ;(taken.server as { port: number }).port = 1
    }).toThrow(TypeError)
  })

  it('advances the revision only on a real resolve', async () => {
    const { container, configuration, mutable } = await setup()

    expect(configuration.revision).toBe(0)

    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)
    expect(configuration.revision).toBe(0)

    mutable.set('server.port', 8080)
    await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)
    expect(configuration.revision).toBe(1)
  })

  describe('env', () => {
    it('reads straight from process.env with no coercion', async () => {
      const { configuration } = await setup()
      process.env.CAFFEINE_CONFIG_ENV_TEST = 'true'

      try {
        // A provider would coerce "true" to a boolean; the escape hatch hands back the raw string.
        expect(configuration.env('CAFFEINE_CONFIG_ENV_TEST')).toBe('true')
      } finally {
        delete process.env.CAFFEINE_CONFIG_ENV_TEST
      }
    })

    it('returns undefined, or the fallback, when the variable is unset', async () => {
      const { configuration } = await setup()
      delete process.env.CAFFEINE_CONFIG_ENV_ABSENT

      expect(configuration.env('CAFFEINE_CONFIG_ENV_ABSENT')).toBeUndefined()
      expect(configuration.env('CAFFEINE_CONFIG_ENV_ABSENT', 'default')).toBe('default')
    })
  })

  describe('either', () => {
    it('reads the selected value from the live handle', async () => {
      const { container, configuration, mutable } = await setup()

      expect(configuration.either(c => c.server.port, 1)).toBe(3000)

      mutable.set('server.port', 8080)
      await container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

      // Live, not latched: a refresh is visible through the selector.
      expect(configuration.either(c => c.server.port, 1)).toBe(8080)
    })

    it('falls back when the selector throws on an undeclared path', async () => {
      const { configuration } = await setup()

      // `misc` is not in the schema, so `misc.value` deep-reads through `undefined` and throws.
      expect(configuration.either(c => (c as unknown as { misc: { value: number } }).misc.value, 42)).toBe(42)
    })

    it('falls back when the selector yields null or undefined', async () => {
      const { configuration } = await setup()

      expect(configuration.either(c => (c.server as { host?: string }).host, 'localhost')).toBe('localhost')
    })
  })

  it('does not collide with an application field named "snapshot"', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.sources.add(new MutableConfigProvider('test').set('snapshot', 'a config value of mine'))
    definition.schema = $t.Object({ snapshot: $t.String() })

    const container = new CaffeineIoC({ decorators: false })
    container.addModules(ConfigModule(definition))
    await container.init()

    // Why a snapshot is not a member of the config object: its keys belong to the application, and one of
    // them may well be called `snapshot`.
    const configuration = container.get(Configuration) as Configuration<{ snapshot: string }>
    expect(configuration.config.snapshot).toBe('a config value of mine')
    expect(configuration.snapshot().snapshot).toBe('a config value of mine')
  })
})
