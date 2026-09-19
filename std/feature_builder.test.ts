import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { CONFIG_REFRESH_LABEL, InlineConfigSource, type ConfigSource } from './config/index.js'
import { kFeatureName } from './feature.js'
import { FeatureBuilder, type FeatureConfigurer } from './feature_builder.js'
import { createApplication, newConfiguration } from './index.js'
import { $t } from './schema/t.js'

interface GadgetConfig {
  size: number
  label: string
}

const gadgetSchema = $t.Object({
  size: $t.Number({ default: 1 }),
  label: $t.String({ default: 'plain' }),
})

const DEFAULTS: GadgetConfig = { size: 1, label: 'plain' }

class GadgetBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'gadget'

  /** What the feature ran on, captured when it bootstrapped. */
  resolved: GadgetConfig | undefined
  /** The node the callback handed over, kept so a refresh can be observed through it. */
  node: Partial<GadgetConfig> | undefined

  #size: number | undefined
  #label: string | undefined

  config(config: Partial<GadgetConfig>): this {
    this.node = config
    return this
  }

  size(size: number): this {
    this.#size = size
    return this
  }

  label(label: string): this {
    this.#label = label
    return this
  }

  /** Merges rather than replaces, so a fluent method can build on what it already wrote. */
  suffix(suffix: string): this {
    this.#label = `${this.#label ?? ''}${suffix}`
    return this
  }

  protected bootstrap(): Promise<void> {
    this.resolved = {
      size: this.#size ?? this.node?.size ?? DEFAULTS.size,
      label: this.#label ?? this.node?.label ?? DEFAULTS.label,
    }

    return Promise.resolve()
  }
}

/** The shape every feature package ships: a factory taking the configure callback, generic over `C`. */
function gadget<C = unknown>(configure?: FeatureConfigurer<GadgetBuilder<C>, C>): GadgetBuilder<C> {
  return new GadgetBuilder<C>(configure as never)
}

const appSchema = $t.Object({ app: $t.Object({ gadget: gadgetSchema }) })
type AppConfig = { app: { gadget: GadgetConfig } }
const kAppConfig = token<AppConfig>(Symbol('app.config'))

const headless = () => createApplication({ container: new CaffeineIoC({ decorators: false }) })

describe('FeatureBuilder', () => {
  it('runs on its own defaults when nothing configured it', async () => {
    const g = gadget()

    await headless().with(g).ready()

    expect(g.resolved).toEqual(DEFAULTS)
  })

  it('keeps a fluent value when no configuration is wired', async () => {
    const g = gadget(b => b.size(7))

    await headless().with(g).ready()

    expect(g.resolved?.size).toBe(7)
  })

  // The semantic the whole mechanism rests on: a fluent method is the last word. Configuration is not a
  // higher band that quietly outranks it — it reaches a feature only where the callback wired it, and this
  // callback did not.
  it('keeps a fluent value even when a source names the same setting', async () => {
    const g = gadget<AppConfig>(b => b.size(7))

    const conf = newConfiguration(appSchema, kAppConfig)
      .source(new InlineConfigSource({ app: { gadget: { size: 99 } } }))
      .build()
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).with(g)

    await app.ready()

    expect(g.resolved?.size).toBe(7)
  })

  // The other half of the same rule, and the only path configuration has into a feature.
  it('reads a setting from the tree when the callback wires it', async () => {
    const g = gadget<AppConfig>((b, c) => b.config(c.app.gadget))

    const conf = newConfiguration(appSchema, kAppConfig)
      .source(new InlineConfigSource({ app: { gadget: { size: 99 } } }))
      .build()
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).with(g)

    await app.ready()

    // `label` was named by neither, so the feature's own default stands.
    expect(g.resolved).toEqual({ size: 99, label: 'plain' })
  })

  it('merges through a fluent method that builds on what it already wrote', async () => {
    const g = gadget(b => b.label('wide').suffix('-ish'))

    await headless().with(g).ready()

    expect(g.resolved?.label).toBe('wide-ish')
  })

  // The callback has to run after configuration resolves, or `c` would carry nothing — and before the
  // feature's own bootstrap, or the builder would not be authored yet when it reads itself.
  it('runs the callback before the feature bootstraps', async () => {
    const order: string[] = []

    class Ordered extends FeatureBuilder {
      readonly [kFeatureName] = 'ordered'

      mark(): this {
        order.push('configure')
        return this
      }

      protected bootstrap(): void {
        order.push('bootstrap')
      }
    }

    await headless()
      .with(new Ordered(b => (b as Ordered).mark()))
      .ready()

    expect(order).toEqual(['configure', 'bootstrap'])
  })

  it('runs the callback before the feature configures', async () => {
    const order: string[] = []

    class Ordered extends FeatureBuilder {
      readonly [kFeatureName] = 'ordered-configure'

      mark(): this {
        order.push('callback')
        return this
      }

      protected configure(): void {
        order.push('configure')
      }
    }

    await headless()
      .with(new Ordered(b => (b as Ordered).mark()))
      .ready()

    expect(order).toEqual(['callback', 'configure'])
  })

  // Liveness is the author's choice, not something the framework manufactures: a node read through follows a
  // refresh, while a scalar copied out of it at bootstrap does not.
  it('hands over a live node, so a refresh is visible through it', async () => {
    let size = 5
    const changing: ConfigSource = {
      name: 'gadget-test',
      live: true,
      load: () => [{ name: 'gadget-test', data: { app: { gadget: { size } } } }],
    }

    const g = gadget<AppConfig>((b, c) => b.config(c.app.gadget))
    const conf = newConfiguration(appSchema, kAppConfig).source(changing).build()
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).with(g)

    await app.ready()

    expect(g.resolved?.size).toBe(5)
    expect(g.node?.size).toBe(5)

    size = 42
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    // The node reads through the tree as it stands now...
    expect(g.node?.size).toBe(42)
    // ...while the value copied out of it at bootstrap is fixed, which is what copying one means.
    expect(g.resolved?.size).toBe(5)
  })
})
