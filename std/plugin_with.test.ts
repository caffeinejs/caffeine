import { token } from '@caffeinejs/di'
import { describe, it, expect } from 'vitest'

import { createApplication } from './application.js'
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

  protected override configure(kit: FeatureConfigureKit<C>): Promise<void> {
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

describe('Application.with', () => {
  it('installs the feature and bootstraps it', async () => {
    const builder = createApplication().with(tracker(t => t.capture('recorded')))

    const app = builder
    await app.ready()

    expect(app.container.getOptional(kSentinel)).toEqual({ value: 'recorded' })
    await app.close()
  })

  it('returns the same builder instance it was called on', () => {
    const builder = createApplication()

    expect(builder.with(tracker())).toBe(builder)
  })

  it('does not add methods to the builder', () => {
    const builder = createApplication().with(tracker())

    // @ts-expect-error features no longer contribute methods
    const missing: unknown = builder.track
    expect(missing).toBeUndefined()
  })

  it('throws when a feature is installed twice', () => {
    expect(() => createApplication().with(tracker()).with(tracker())).toThrow(ErrFeatureAlreadyInstalled)
  })

  it('throws when a keyed instance is installed twice', () => {
    expect(() => createApplication().with(keyed()).with(keyed())).toThrow(ErrFeatureAlreadyInstalled)
    expect(() => createApplication().with(keyed('orders')).with(keyed('orders'))).toThrow(ErrFeatureAlreadyInstalled)
  })

  it('allows distinct keyed instances', () => {
    const builder = createApplication().with(keyed()).with(keyed('orders'))
    expect(builder).toBeDefined()
  })
})
