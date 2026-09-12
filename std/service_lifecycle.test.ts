import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { Application } from './application.js'
import { InlineConfigProvider, type ConfigHandle } from './config/index.js'
import { kBootstrap, kFeatureName, type BootstrapKit, type ExtensionRegistrar, type Feature } from './feature.js'
import { createApplication } from './index.js'
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

  [kBootstrap](kit: BootstrapKit<AppConfig>): Promise<void> {
    this.bound = kit.config.widget.size
    kit.container.bind(token<number | undefined>('widget.size'), t => t.toValue(this.bound))
    return Promise.resolve()
  }
}

function appWith(feature: Feature<never>, size: number) {
  return createApplication({ container: new CaffeineIoC({ decorators: false }) })
    .addFeature(feature)
    .config(schema, kConfig, c => c.source(new InlineConfigProvider({ widget: { size } })))
    .build()
}

describe('feature lifecycle', () => {
  // The one ordering guarantee the mechanism rests on: configuration resolves before any feature
  // bootstraps, and binding is still open when it does. Resolving inside `container.init()` would be too
  // late for both.
  it('resolves configuration before a feature bootstraps, while it can still bind', async () => {
    const feature = new WidgetFeature()
    const app = appWith(feature as Feature<never>, 42)

    await app.ready()

    expect(feature.bound).toBe(42)
    expect(app.container.get(token<number | undefined>('widget.size'))).toBe(42)
  })

  it('runs a feature that reads no configuration at all', async () => {
    let bootstrapped = false

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .addFeature({
        get [kFeatureName](): string {
          return 'noop'
        },
        [kBootstrap](): Promise<void> {
          bootstrapped = true
          return Promise.resolve()
        },
      })
      .build()

    await app.ready()

    expect(bootstrapped).toBe(true)
  })

  // A tree that cannot validate is a broken application, and saying so at `ready()` is earlier and more
  // legible than failing at whatever moment a feature first read it.
  it('fails start-up when the configuration cannot be validated, before anything binds', async () => {
    let bootstrapped = false

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .addFeature({
        get [kFeatureName](): string {
          return 'strict'
        },
        [kBootstrap](): Promise<void> {
          bootstrapped = true
          return Promise.resolve()
        },
      })
      // The tree carries a string where the schema declares a number.
      .config(schema, kConfig, c => c.source(new InlineConfigProvider({ widget: { size: 'not-a-number' } })))
      .build()

    await expect(app.ready()).rejects.toThrow()
    expect(bootstrapped).toBe(false)
  })
})

describe('extension registration', () => {
  // What a platform does with what it is handed is the platform's own test. What `std` owes it is the
  // install position: every feature is asked for a registrar under its own index, and the index is the
  // feature's place in the list rather than the order the bootstrap hooks happened to reach the call. That
  // is the whole ordering model now that there are no stages, so a feature that awaits first must not move.
  it('asks for a registrar under each feature position, whatever a bootstrap awaits', async () => {
    const asked: number[] = []
    const registered: Array<[number, string]> = []

    const registering = (name: string, awaits: number): Feature => ({
      [kFeatureName]: name,
      async [kBootstrap](kit: BootstrapKit): Promise<void> {
        for (let i = 0; i < awaits; i++) {
          await Promise.resolve()
        }
        kit.extensions.register(name)
      },
    })

    class Recording extends Application {
      protected override extensionRegistrar(order: number): ExtensionRegistrar {
        asked.push(order)

        return {
          register: extension => {
            registered.push([order, extension as string])
          },
        }
      }
    }

    // "slow" bootstraps second but awaits longer, so it registers last in wall-clock order.
    const app = new Recording({
      container: new CaffeineIoC({ decorators: false }),
      services: [registering('slow', 3), registering('quick', 0)],
    })

    await app.ready()

    expect(asked).toEqual([0, 1])
    expect(registered).toEqual([
      [1, 'quick'],
      [0, 'slow'],
    ])
  })
})
