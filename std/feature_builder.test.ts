import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import {
  featureConfigKey,
  InlineConfigProvider,
  type ConfigHandle,
  type ConfigLocation,
  type ConfigSlice,
} from './config/index.js'
import { kFeatureName } from './feature.js'
import { ErrFeatureNotDeclared, FeatureBuilder } from './feature_builder.js'
import { createApplication } from './index.js'
import { $t } from './schema/t.js'

interface GadgetConfig {
  size: number
  label: string
}

const gadgetSchema = $t.Object({
  size: $t.Number({ default: 1 }),
  label: $t.String({ default: 'plain' }),
})

const kGadgetConfig = featureConfigKey<GadgetConfig>('gadget')

/** What a feature reads once the raw settings are folded into the shape it runs on. */
interface GadgetOptions {
  size: number
  title: string
}

const kGadgetOptions = featureConfigKey<GadgetOptions>('gadget.options')

class GadgetBuilder<C = unknown> extends FeatureBuilder<GadgetConfig, C> {
  readonly [kFeatureName] = 'gadget'

  resolved: GadgetConfig | undefined

  protected readonly schema = gadgetSchema
  protected readonly configKey = kGadgetConfig
  protected readonly defaults = { size: 1, label: 'plain' }

  size(size: number): this {
    return this.set('size', size)
  }

  label(label: string): this {
    return this.set('label', label)
  }

  /** Merges rather than replaces, which is what `get` is for. */
  suffix(suffix: string): this {
    return this.set('label', `${this.get('label') ?? ''}${suffix}`)
  }

  /** Reaching the slice from a fluent method is the mistake the guard is for; this makes it. */
  readEarly(): GadgetConfig {
    return this.slice.config
  }

  protected bootstrap(): Promise<void> {
    this.resolved = this.slice.config
    return Promise.resolve()
  }
}

/** A feature whose readers want the folded shape, not the raw settings. */
class DerivedGadgetBuilder extends GadgetBuilder {
  options: ConfigSlice<GadgetOptions> | undefined

  protected override beforeBootstrap(): void {
    this.options = this.derive(config => ({ size: config.size, title: config.label.toUpperCase() }), kGadgetOptions)
  }
}

const appSchema = $t.Object({ app: $t.Object({ gadget: gadgetSchema }) })
type AppConfig = { app: { gadget: GadgetConfig } }
const kAppConfig = token<ConfigHandle<AppConfig>>(Symbol('app.config'))

/** An application that declares nothing of its own, so a detached feature is still reachable by key. */
const kBareConfig = token<ConfigHandle<Record<never, never>>>(Symbol('bare.config'))

function appWith(builder: GadgetBuilder<AppConfig>, values?: Partial<GadgetConfig>) {
  return createApplication({ container: new CaffeineIoC({ decorators: false }) })
    .addFeature(builder)
    .config(appSchema, kAppConfig, c =>
      values === undefined ? c : c.source(new InlineConfigProvider({ app: { gadget: values } })),
    )
    .build()
}

describe('FeatureBuilder', () => {
  it('resolves detached from its defaults and its fluent values when nothing placed it', async () => {
    const gadget = new GadgetBuilder()

    await createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .addFeature(gadget)
      .build()
      .ready()

    expect(gadget.resolved).toEqual({ size: 1, label: 'plain' })
  })

  it('keeps a fluent value when the feature is detached', async () => {
    const gadget = new GadgetBuilder().size(7)

    await createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .addFeature(gadget)
      .build()
      .ready()

    expect(gadget.resolved?.size).toBe(7)
  })

  // The point of routing everything through the tree: a value set in code is a default, not an override, so
  // one image can ship with sensible settings and still be redirected on deploy.
  it('lets a configuration source beat a value the fluent method set', async () => {
    const gadget = new GadgetBuilder<AppConfig>().size(7)
    gadget.config(c => c.app.gadget as ConfigLocation<GadgetConfig>)

    await appWith(gadget, { size: 99 }).ready()

    expect(gadget.resolved?.size).toBe(99)
  })

  it('reads a field no source set from the fluent value', async () => {
    const gadget = new GadgetBuilder<AppConfig>().size(7).label('wide')
    gadget.config(c => c.app.gadget as ConfigLocation<GadgetConfig>)

    await appWith(gadget, { size: 99 }).ready()

    expect(gadget.resolved).toEqual({ size: 99, label: 'wide' })
  })

  it('merges through get, so a fluent method can build on what it already wrote', async () => {
    const gadget = new GadgetBuilder().label('wide').suffix('-ish')

    await createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .addFeature(gadget)
      .build()
      .ready()

    expect(gadget.resolved?.label).toBe('wide-ish')
  })

  // The key is what lets code holding no builder read the settings — it does not move when the application
  // points the feature somewhere else.
  it('publishes the slice under its key', async () => {
    const gadget = new GadgetBuilder<AppConfig>().size(7)
    gadget.config(c => c.app.gadget as ConfigLocation<GadgetConfig>)

    const app = appWith(gadget, { size: 99 })
    await app.ready()

    expect(app.container.get(kAppConfig)(kGadgetConfig)).toEqual({ size: 99, label: 'plain' })
  })

  it('answers a key with the derived shape when the feature derived one', async () => {
    const gadget = new DerivedGadgetBuilder()

    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) })
      .addFeature(gadget)
      .config($t.Object({}), kBareConfig, c => c)
      .build()
    await app.ready()

    expect(app.container.get(kBareConfig)(kGadgetOptions)).toEqual({ size: 1, title: 'PLAIN' })
  })

  // Reading it from a fluent method would be reading a value nothing has resolved: the application has not
  // even said where the settings live yet.
  it('refuses to hand out the slice before the feature declared it', () => {
    const gadget = new GadgetBuilder()

    expect(() => gadget.size(7).readEarly()).toThrow(ErrFeatureNotDeclared)
  })
})
