import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { CONFIG_REFRESH_LABEL, type ConfigSource } from './config/index.js'
import { InlineConfigSource } from './config/sources/inline/index.js'
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

  protected override bootstrap(): Promise<void> {
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

const headless = () => createApplication({ container: new CaffeineIoC({ decorators: false }) })

describe('FeatureBuilder', () => {
  it('runs on its own defaults when nothing configured it', async () => {
    const g = gadget()

    await headless().install(g).bootstrap()

    expect(g.resolved).toEqual(DEFAULTS)
  })

  it('keeps a fluent value when no configuration is wired', async () => {
    const g = gadget(b => b.size(7))

    await headless().install(g).bootstrap()

    expect(g.resolved?.size).toBe(7)
  })

  // The semantic the whole mechanism rests on: a fluent method is the last word. Configuration is not a
  // higher band that quietly outranks it — it reaches a feature only where the callback wired it, and this
  // callback did not.
  it('keeps a fluent value even when a source names the same setting', async () => {
    const g = gadget<AppConfig>(b => b.size(7))

    const conf = newConfiguration(appSchema)
      .source(new InlineConfigSource({ app: { gadget: { size: 99 } } }))
      .build().config
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).install(g)

    await app.bootstrap()

    expect(g.resolved?.size).toBe(7)
  })

  // The other half of the same rule, and the only path configuration has into a feature.
  it('reads a setting from the tree when the callback wires it', async () => {
    const g = gadget<AppConfig>((b, { config }) => b.config(config.app.gadget))

    const conf = newConfiguration(appSchema)
      .source(new InlineConfigSource({ app: { gadget: { size: 99 } } }))
      .build().config
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).install(g)

    await app.bootstrap()

    // `label` was named by neither, so the feature's own default stands.
    expect(g.resolved).toEqual({ size: 99, label: 'plain' })
  })

  // The kit is the whole reason the callback takes one context argument rather than the configuration alone:
  // it runs while binding is still open, so an application can bind alongside the feature it is configuring
  // instead of installing a second feature to do it.
  it('binds into the container from the callback', async () => {
    const kLabelSource = token<string>(Symbol('gadget.label.source'))

    const g = gadget<AppConfig>((b, { config, container }) => {
      container.bind(kLabelSource, t => t.toValue(`configured:${config.app.gadget.size}`))
      b.config(config.app.gadget)
    })

    const conf = newConfiguration(appSchema)
      .source(new InlineConfigSource({ app: { gadget: { size: 12 } } }))
      .build().config
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).install(g)

    await app.bootstrap()

    expect(app.container.get(kLabelSource)).toBe('configured:12')
  })

  it('merges through a fluent method that builds on what it already wrote', async () => {
    const g = gadget(b => b.label('wide').suffix('-ish'))

    await headless().install(g).bootstrap()

    expect(g.resolved?.label).toBe('wide-ish')
  })

  // The callback has to run after configuration resolves, or the kit's `config` would carry nothing — and
  // before the feature's own bootstrap, or the builder would not be authored yet when it reads itself.
  it('runs the callback before the feature bootstraps', async () => {
    const order: string[] = []

    class Ordered extends FeatureBuilder {
      readonly [kFeatureName] = 'ordered'

      mark(): this {
        order.push('configure')
        return this
      }

      protected override bootstrap(): void {
        order.push('bootstrap')
      }
    }

    await headless()
      .install(new Ordered(b => (b as Ordered).mark()))
      .bootstrap()

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

      protected override configure(): void {
        order.push('configure')
      }
    }

    await headless()
      .install(new Ordered(b => (b as Ordered).mark()))
      .bootstrap()

    expect(order).toEqual(['callback', 'configure'])
  })

  // A feature is configured once, from the configuration the application started with: a node handed to its builder
  // is a frozen snapshot, so a later refresh cannot change what the feature was built from behind its back. Code that
  // must follow a reload asks for the live token, or subscribes to the store.
  it('hands over a snapshot node, which a refresh does not reach', async () => {
    let size = 5
    const changing: ConfigSource = {
      name: 'gadget-test',
      live: true,
      load: () => [{ name: 'gadget-test', data: { app: { gadget: { size } } } }],
    }

    const g = gadget<AppConfig>((b, { config }) => b.config(config.app.gadget))
    const conf = newConfiguration(appSchema).source(changing).build().config
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config: conf }).install(g)

    await app.bootstrap()

    expect(g.node?.size).toBe(5)
    expect(Object.isFrozen(g.node)).toBe(true)

    size = 42
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(app.config.app.gadget.size).toBe(42)
    expect(g.node?.size).toBe(5)
    expect(g.resolved?.size).toBe(5)
  })
})
