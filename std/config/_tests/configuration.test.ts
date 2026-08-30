import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'
import { $t } from '../../schema/t.js'
import { ConfigDefinition } from '../definition.js'
import { ConfigPriority } from '../sources.js'
import { Configuration, kConfiguration } from '../configuration.js'
import { CONFIG_REFRESH_LABEL, ConfigModule } from '../integration/module.js'
import { MutableConfigProvider } from '../providers/mutable_provider.js'

const APP_CONFIG = token<any>(Symbol('app.config'))

interface App { server: { port: number } }

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

  return { container, configuration: container.get<Configuration<App>>(kConfiguration), mutable }
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
      (taken.server as { port: number }).port = 1
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

  it('does not collide with an application field named "snapshot"', async () => {
    const definition = new ConfigDefinition(APP_CONFIG)
    definition.sources.add(new MutableConfigProvider('test').set('snapshot', 'a config value of mine'))
    definition.schema = $t.Object({ snapshot: $t.String() })

    const container = new CaffeineIoC({ decorators: false })
    container.addModules(ConfigModule(definition))
    await container.init()

    // Why a snapshot is not a member of the config object: its keys belong to the application, and one of
    // them may well be called `snapshot`.
    const configuration = container.get<Configuration<{ snapshot: string }>>(kConfiguration)
    expect(configuration.config.snapshot).toBe('a config value of mine')
    expect(configuration.snapshot().snapshot).toBe('a config value of mine')
  })
})
