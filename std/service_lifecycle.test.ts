import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { InlineConfigProvider, type ConfigHandle, type ConfigSlice } from './config/index.js'
import { ErrContributionPhase, contributionKey } from './contributions.js'
import { createApplication } from './index.js'
import { type BeforeBootstrapKit, type BootstrapKit, type FeatureLifecycle } from './lifecycle.js'
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

  get name(): string {
    return 'widget'
  }

  beforeBootstrap(kit: BeforeBootstrapKit): void {
    this.steps.push('declare')
    this.slice = kit.config.slice(['widget'], widgetSchema)
  }

  bootstrap(kit: BootstrapKit): Promise<void> {
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

      get name(): string {
        return 'too-early'
      }

      beforeBootstrap(kit: BeforeBootstrapKit): void {
        const slice = kit.config.slice(['widget'], widgetSchema)
        try {
          void slice.config
        } catch (error) {
          this.error = error
        }
      }

      bootstrap(): Promise<void> {
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
        get name(): string {
          return 'noop'
        },
        bootstrap(): Promise<void> {
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

      get name(): string {
        return 'strict'
      }

      beforeBootstrap(kit: BeforeBootstrapKit) {
        // The tree carries a number here, so a string schema cannot validate.
        kit.config.slice(['widget', 'size'], $t.Object({ nested: $t.String() }))
      }

      bootstrap(kit: BootstrapKit): Promise<void> {
        this.configured = true
        return Promise.resolve()
      }
    }

    const service = new Strict()

    await expect(appWith(service, 42).ready()).rejects.toMatchObject({ code: 'ERR_CONFIG_SLICES' })
    expect(service.configured).toBe(false)
  })
})

describe('contributions in the lifecycle', () => {
  const kWidget = contributionKey<number>('test:widget.size')

  class ContributingService implements FeatureLifecycle {
    get name(): string {
      return 'contributor'
    }

    bootstrap(kit: BootstrapKit): Promise<void> {
      kit.contributions.contribute(kWidget, 7)
      return Promise.resolve()
    }
  }

  it('seals what services contributed, and the application can read it', async () => {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .addFeature(new ContributingService())
      .build()

    await app.ready()

    expect(app.contributions.sealed).toBe(true)
    expect(app.contributions.get(kWidget)).toBe(7)
  })

  // Services bootstrap concurrently, so answering this would mean answering it by scheduling order.
  it('refuses a read from inside bootstrap, where the answer would be a race', async () => {
    let caught: unknown

    class ReadingService implements FeatureLifecycle {
      get name(): string {
        return 'reader'
      }

      bootstrap(kit: BootstrapKit): Promise<void> {
        try {
          kit.contributions.get(kWidget)
        } catch (error) {
          caught = error
        }
        return Promise.resolve()
      }
    }

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .addFeature(new ContributingService())
      .addFeature(new ReadingService())
      .build()

    await app.ready()

    expect(caught).toBeInstanceOf(ErrContributionPhase)
  })
})
