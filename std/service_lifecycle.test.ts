import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { InlineConfigProvider, type ConfigHandle, type ConfigSlice } from './config/index.js'
import type { Extension } from './extensions.js'
import { createApplication } from './index.js'
import {
  kBeforeBootstrap,
  kBootstrap,
  kFeatureName,
  type BeforeBootstrapKit,
  type BootstrapKit,
  type FeatureLifecycle,
} from './lifecycle.js'
import { $t } from './schema/t.js'

const schema = $t.Object({ widget: $t.Object({ size: $t.Number() }) })
const kConfig = token<ConfigHandle<{ widget: { size: number } }>>(Symbol('app.config'))
const widgetSchema = $t.Object({ size: $t.Optional($t.Number()) })

interface WidgetConfig {
  size?: number
}

/** A minimal feature: declares a slice, then binds what it resolved to. */
class WidgetService implements FeatureLifecycle {
  readonly steps: string[] = []
  slice: ConfigSlice<WidgetConfig> | undefined
  bound: number | undefined

  get [kFeatureName](): string {
    return 'widget'
  }

  [kBeforeBootstrap](kit: BeforeBootstrapKit): void {
    this.steps.push('declare')
    this.slice = kit.config.slice(['widget'], widgetSchema)
  }

  [kBootstrap](kit: BootstrapKit): Promise<void> {
    this.steps.push('configure')
    this.bound = this.slice!.config.size
    kit.container.bind(token<number | undefined>('widget.size'), t => t.toValue(this.bound))
    return Promise.resolve()
  }
}

function appWith(service: FeatureLifecycle, size: number) {
  return createApplication({ container: new CaffeineIoC({ decorators: false }) })
    .addFeature(service)
    .config(schema, kConfig, c => c.source(new InlineConfigProvider({ widget: { size } })))
    .build()
}

describe('service lifecycle', () => {
  it('declares every service, resolves configuration, then configures', async () => {
    const service = new WidgetService()

    await appWith(service, 42).ready()

    expect(service.steps).toEqual(['declare', 'configure'])
  })

  // The whole point of the split: a feature binds a value it could not have known while declaring.
  it('lets a service read its resolved slice while it is still able to bind', async () => {
    const service = new WidgetService()
    const app = appWith(service, 42)

    await app.ready()

    expect(service.bound).toBe(42)
    expect(app.container.get(token<number | undefined>('widget.size'))).toBe(42)
  })

  it('refuses a slice read from the declare step, where nothing has resolved yet', async () => {
    class TooEarly implements FeatureLifecycle {
      error: unknown

      get [kFeatureName](): string {
        return 'too-early'
      }

      [kBeforeBootstrap](kit: BeforeBootstrapKit): void {
        const slice = kit.config.slice(['widget'], widgetSchema)
        try {
          void slice.config
        } catch (error) {
          this.error = error
        }
      }

      [kBootstrap](): Promise<void> {
        return Promise.resolve()
      }
    }

    const service = new TooEarly()
    await appWith(service, 1).ready()

    expect(service.error).toMatchObject({ name: 'ErrConfig', code: 'ERR_CONFIG_NOT_RESOLVED' })
  })

  // `declare` is optional: a service that only binds does not have to implement it.
  it('runs a service that declares nothing', async () => {
    let configured = false

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .addFeature({
        get [kFeatureName](): string {
          return 'noop'
        },
        [kBootstrap](): Promise<void> {
          configured = true
          return Promise.resolve()
        },
      })
      .build()

    await app.ready()

    expect(configured).toBe(true)
  })

  it('fails start-up when a slice cannot be resolved, before anything binds', async () => {
    class Strict implements FeatureLifecycle {
      configured: boolean = false

      get [kFeatureName](): string {
        return 'strict'
      }

      [kBeforeBootstrap](kit: BeforeBootstrapKit) {
        // The tree carries a number here, so a string schema cannot validate.
        kit.config.slice(['widget', 'size'], $t.Object({ nested: $t.String() }))
      }

      [kBootstrap](kit: BootstrapKit): Promise<void> {
        this.configured = true
        return Promise.resolve()
      }
    }

    const service = new Strict()

    await expect(appWith(service, 42).ready()).rejects.toMatchObject({ code: 'ERR_CONFIG_SLICES' })
    expect(service.configured).toBe(false)
  })
})

describe('extension registration', () => {
  // What the registry does with the ordinals is `Extensions`' own test; what `std` owes a feature is a
  // registrar on its kit, and one that is distinct per feature — that is what carries the install position.
  it('hands every feature its own registrar, usable while it binds', async () => {
    const registrars: unknown[] = []

    const registering = (name: string): FeatureLifecycle => ({
      [kFeatureName]: name,
      async [kBootstrap](kit: BootstrapKit): Promise<void> {
        await Promise.resolve()
        const key = token<Extension>(Symbol(`ext.${name}`))
        kit.container.bind(key, t => t.toValue({ name, configure: () => undefined }))
        kit.extensions.add(key)
        registrars.push(kit.extensions)
      },
    })

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .addFeature(registering('first'))
      .addFeature(registering('second'))
      .build()

    await app.ready()

    expect(registrars).toHaveLength(2)
    expect(registrars[0]).not.toBe(registrars[1])
  })
})
