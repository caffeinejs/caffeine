import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { InlineConfigProvider, type ConfigHandle } from './config/index.js'
import {
  kFeatureBootstrap,
  kFeatureConfigure,
  kFeatureName,
  type BootstrapKit,
  type Feature,
  type FeatureConfigureKit,
} from './feature.js'
import { createApplication, newConfiguration } from './index.js'
import { newNoopLogger, type Logger } from './logger/index.js'
import { $t } from './schema/t.js'

const schema = $t.Object({ widget: $t.Object({ size: $t.Number() }) })
type AppConfig = { widget: { size: number } }
const kConfig = token<ConfigHandle<AppConfig>>(Symbol('app.config'))

/** A minimal feature: reads the resolved configuration, then binds what it found. */
class WidgetFeature implements Feature<AppConfig> {
  bound: number | undefined

  get [kFeatureName](): string {
    return 'widget'
  }

  [kFeatureConfigure](kit: FeatureConfigureKit<AppConfig>): Promise<void> {
    this.bound = kit.config.widget.size
    kit.container.bind(token<number | undefined>('widget.size'), t => t.toValue(this.bound))
    return Promise.resolve()
  }

  [kFeatureBootstrap](): Promise<void> {
    return Promise.resolve()
  }
}

function appWith(feature: Feature<never>, size: number) {
  const conf = newConfiguration(schema, kConfig)
    .source(new InlineConfigProvider({ widget: { size } }))
    .build()
  return createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).addFeature(feature)
}

describe('feature lifecycle', () => {
  // The one ordering guarantee the mechanism rests on: configuration resolves before any feature
  // configures, and binding is still open when it does. Resolving inside `container.init()` would be too
  // late for both.
  it('resolves configuration before a feature configures, while it can still bind', async () => {
    const feature = new WidgetFeature()
    const app = appWith(feature as Feature<never>, 42)

    await app.ready()

    expect(feature.bound).toBe(42)
    expect(app.container.get(token<number | undefined>('widget.size'))).toBe(42)
  })

  it('runs a feature that reads no configuration at all', async () => {
    let configured = false

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).addFeature({
      get [kFeatureName](): string {
        return 'noop'
      },
      [kFeatureConfigure](): Promise<void> {
        configured = true
        return Promise.resolve()
      },
      [kFeatureBootstrap](): Promise<void> {
        return Promise.resolve()
      },
    })

    await app.ready()

    expect(configured).toBe(true)
  })

  // A tree that cannot validate is a broken application, and saying so at `ready()` is earlier and more
  // legible than failing at whatever moment a feature first read it.
  it('fails start-up when the configuration cannot be validated, before anything binds', async () => {
    let configured = false

    // The tree carries a string where the schema declares a number.
    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigProvider({ widget: { size: 'not-a-number' } }))
      .build()

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).addFeature({
      get [kFeatureName](): string {
        return 'strict'
      },
      [kFeatureConfigure](): Promise<void> {
        configured = true
        return Promise.resolve()
      },
      [kFeatureBootstrap](): Promise<void> {
        return Promise.resolve()
      },
    })

    await expect(app.ready()).rejects.toThrow()
    expect(configured).toBe(false)
  })

  it('configures before the container initializes, and bootstraps after', async () => {
    const order: string[] = []

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).addFeature({
      [kFeatureName]: 'order',
      [kFeatureConfigure](): void {
        order.push('configure')
      },
      [kFeatureBootstrap](): void {
        order.push('bootstrap')
      },
    })

    const init = app.container.init.bind(app.container)
    app.container.init = async () => {
      order.push('init')
      await init()
    }

    await app.ready()

    expect(order).toEqual(['configure', 'init', 'bootstrap'])
  })
})

describe('bootstrap', () => {
  // Bootstrap is only for looking bindings up after `container.init()`. A feature that has nothing to look up
  // should not have to say so, which is why the hook is optional.
  it('readies a feature that declares no bootstrap hook', async () => {
    let configured = false

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).addFeature({
      [kFeatureName]: 'configure-only',
      [kFeatureConfigure](): void {
        configured = true
      },
    })

    await app.ready()

    expect(configured).toBe(true)
  })

  // The logger feature configures in the same phase as every other feature, so a feature cannot read the final
  // logger while configuring. By bootstrap it is settled, and the kit must carry that one, not the eager default
  // the application started with: otherwise `.logger(b => b.use(...))` would not reach feature code.
  it('hands bootstrap the logger the application configured', async () => {
    const custom: Logger = { ...newNoopLogger() }
    let seen: Logger | undefined

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .logger(b => b.use(custom))
      .addFeature({
        [kFeatureName]: 'reads-logger',
        [kFeatureConfigure](): void {
          // Nothing to bind.
        },
        [kFeatureBootstrap](kit: BootstrapKit): void {
          seen = kit.logger
        },
      })

    await app.ready()

    expect(seen).toBe(custom)
  })
})
