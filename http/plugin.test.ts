import { CaffeineIoC, token } from '@caffeinejs/di'
import {
  FeatureBuilder,
  kFeatureName,
  newConfiguration,
  type Feature,
  type FeatureConfigureKit,
  type FeatureConfigurer,
} from '@caffeinejs/std'
import type { InferConfig } from '@caffeinejs/std/config'
import { EnvConfigSource } from '@caffeinejs/std/config/env'
import { $t } from '@caffeinejs/std/schema'
import { describe, it, expect } from 'vitest'

import { ErrConfiguration, createWebApplication } from './index.js'

// A sentinel the feature's configurer binds into the container so a test can prove the feature rode
// the same `bootstrap()` path as the built-in auth/authz services.
const kProbe = token<Record<string, unknown>>(Symbol('probe-sentinel'))

class ProbeBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'probe'

  #broker: string | undefined

  capture(broker: string): this {
    this.#broker = broker
    return this
  }

  protected override configure(kit: FeatureConfigureKit<C>): Promise<void> {
    const broker = this.#broker
    kit.container.bind(kProbe, t => t.toValue({ broker }))
    return Promise.resolve()
  }
}

function probe<C = unknown>(configure?: FeatureConfigurer<ProbeBuilder<C>, C>): Feature<C> {
  return new ProbeBuilder<C>(configure as never)
}

describe('WebApplication.install()', () => {
  it('installs the feature and rides the bootstrap path into the container', async () => {
    const container = new CaffeineIoC()
    const app = createWebApplication({ container }).install(probe(t => t.capture('localhost:9092')))

    await app.bootstrap()

    expect(app.container.getOptional(kProbe)).toEqual({ broker: 'localhost:9092' })
  })

  it('does not add methods to the builder', () => {
    const app = createWebApplication({}).install(probe())
    // @ts-expect-error features no longer contribute methods
    const missing: unknown = app.probe
    expect(missing).toBeUndefined()
  })

  it('flows the config type to features configured after construction', async () => {
    const container = new CaffeineIoC()
    const schema = $t.Object({ nothing: $t.String({ default: '' }) })
    const kConfig = token<InferConfig<typeof schema>>(Symbol('app.config'))
    const conf = newConfiguration(schema, kConfig).source(new EnvConfigSource()).build()

    const app = createWebApplication({ container, config: conf }).install(probe(t => t.capture('after-config:9092')))

    await app.bootstrap()

    expect(app.container.getOptional(kProbe)).toEqual({ broker: 'after-config:9092' })
  })

  it('types a feature configured after construction against the constructor-supplied config', () => {
    const schema = $t.Object({ app: $t.Object({ server: $t.Object({ host: $t.String(), port: $t.Number() }) }) })
    const kConfig = token<InferConfig<typeof schema>>(Symbol('app.config'))
    const conf = newConfiguration(schema, kConfig).source(new EnvConfigSource()).build()

    const app = createWebApplication({ config: conf })
      .install(probe())
      .server(({ config }) => ({ listener: config.app.server }))

    expect(typeof app.bootstrap).toBe('function')
  })
})

describe('WebApplication.with()', () => {
  // The compiler already refuses these; the runtime error is for a feature smuggled past it, where the silent
  // alternative would be an extension the adapter cannot install.
  it('refuses a feature, naming it and pointing at .install()', () => {
    // @ts-expect-error a feature is not a plugin factory
    expect(() => createWebApplication().with(probe())).toThrow(ErrConfiguration)
    // @ts-expect-error a feature is not a plugin factory
    expect(() => createWebApplication().with(probe())).toThrow(
      'Cannot register feature "probe" with ".with(...)": a feature is not a server plugin',
    )
  })

  it('refuses a value that is neither a feature nor a factory', () => {
    // @ts-expect-error a plugin factory is a function
    expect(() => createWebApplication().with({ not: 'a-plugin' })).toThrow(
      'Cannot register an HTTP plugin: expected a plugin factory function, got object',
    )
  })

  // Read naively, the feature check would throw a `TypeError` here before the refusal could name the value.
  it('refuses null and undefined the same way', () => {
    // @ts-expect-error a plugin factory is a function
    expect(() => createWebApplication().with(null)).toThrow(
      'Cannot register an HTTP plugin: expected a plugin factory function, got null',
    )
    // @ts-expect-error a plugin factory is a function
    expect(() => createWebApplication().with(undefined)).toThrow(
      'Cannot register an HTTP plugin: expected a plugin factory function, got undefined',
    )
  })
})
