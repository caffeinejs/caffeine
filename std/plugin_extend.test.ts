import { token } from '@caffeinejs/di'
import { describe, it, expect } from 'vitest'
import { z } from 'zod'

import { createApplication } from './application_builder.js'
import { InlineConfigProvider, type ConfigHandle } from './config/index.js'
import { ErrFeatureAlreadyInstalled, kFeatureName, type Feature, type FeatureConfigureKit } from './feature.js'
import { FeatureBuilder, type FeatureConfigurer } from './feature_builder.js'

const kSentinel = token<Record<string, unknown>>(Symbol('extend-sentinel'))

class TrackerBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly #name: string

  #value: string | undefined

  constructor(name: string, configure?: FeatureConfigurer<never, C>) {
    super(configure)
    this.#name = name
  }

  get [kFeatureName](): string {
    return this.#name
  }

  capture(value: string): this {
    this.#value = value
    return this
  }

  protected configure(kit: FeatureConfigureKit<C>): Promise<void> {
    const value = this.#value
    kit.container.bind(kSentinel, t => t.toValue({ value }))
    return Promise.resolve()
  }
}

function tracker<C = unknown>(configure?: FeatureConfigurer<TrackerBuilder<C>, C>): Feature<C> {
  return new TrackerBuilder<C>('track', configure as never)
}

/** An instanced feature: the instance folds into the name `.extend` deduplicates on. */
function keyed(instance = 'default'): Feature {
  return new TrackerBuilder(instance === 'default' ? 'keyed' : `keyed:${instance}`)
}

describe('BaseApplicationBuilder.extend', () => {
  it('installs the feature and bootstraps it', async () => {
    const builder = createApplication().extend(tracker(t => t.capture('recorded')))

    const app = builder.build()
    await app.ready()

    expect(app.container.getOptional(kSentinel)).toEqual({ value: 'recorded' })
    await app.close()
  })

  it('returns the same builder instance it was called on', () => {
    const builder = createApplication()

    expect(builder.extend(tracker())).toBe(builder)
  })

  it('does not add methods to the builder', () => {
    const builder = createApplication().extend(tracker())

    // @ts-expect-error features no longer contribute methods
    const missing: unknown = builder.track
    expect(missing).toBeUndefined()
  })

  it('keeps .extend available across .config(), in either order', () => {
    const schema = z.object({ server: z.object({ port: z.coerce.number() }) })
    const kConfig = token<ConfigHandle<z.infer<typeof schema>>>(Symbol('app.config'))

    const afterConfig = createApplication()
      .extend(tracker())
      .config(schema, kConfig, c => c.source(new InlineConfigProvider({ server: { port: 1 } })))

    const beforeConfig = createApplication()
      .config(schema, kConfig, c => c.source(new InlineConfigProvider({ server: { port: 1 } })))
      .extend(tracker())

    expect(typeof afterConfig.extend).toBe('function')
    expect(typeof beforeConfig.extend).toBe('function')
  })

  it('throws when a feature is installed twice', () => {
    expect(() => createApplication().extend(tracker()).extend(tracker())).toThrow(ErrFeatureAlreadyInstalled)
  })

  it('throws when a keyed instance is installed twice', () => {
    expect(() => createApplication().extend(keyed()).extend(keyed())).toThrow(ErrFeatureAlreadyInstalled)
    expect(() => createApplication().extend(keyed('orders')).extend(keyed('orders'))).toThrow(
      ErrFeatureAlreadyInstalled,
    )
  })

  it('allows distinct keyed instances', () => {
    const builder = createApplication().extend(keyed()).extend(keyed('orders'))
    expect(builder).toBeDefined()
  })
})
