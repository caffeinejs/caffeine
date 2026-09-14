import { CaffeineIoC, token } from '@caffeinejs/di'
import {
  $t,
  FeatureBuilder,
  kFeatureName,
  type Feature,
  type FeatureConfigureKit,
  type FeatureConfigurer,
  type InferSchema,
} from '@caffeinejs/std'
import { EnvConfigProvider, type ConfigHandle } from '@caffeinejs/std/config'
import Fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import { createWebApplication, fastifyAdapterFactory } from './index.js'

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

  protected configure(kit: FeatureConfigureKit<C>): Promise<void> {
    const broker = this.#broker
    kit.container.bind(kProbe, t => t.toValue({ broker }))
    return Promise.resolve()
  }
}

function probe<C = unknown>(configure?: FeatureConfigurer<ProbeBuilder<C>, C>): Feature<C> {
  return new ProbeBuilder<C>(configure as never)
}

describe('builder.with()', () => {
  it('installs the feature and rides the bootstrap path into the container', async () => {
    const container = new CaffeineIoC()
    const app = createWebApplication(fastifyAdapterFactory(Fastify()), { container }).with(
      probe(t => t.capture('localhost:9092')),
    )

    const built = app.build()
    await built.ready()

    expect(built.container.getOptional(kProbe)).toEqual({ broker: 'localhost:9092' })
  })

  it('does not add methods to the builder', () => {
    const app = createWebApplication(fastifyAdapterFactory(Fastify()), {}).with(probe())
    // @ts-expect-error features no longer contribute methods
    const missing: unknown = app.probe
    expect(missing).toBeUndefined()
  })

  it('keeps .with available across .config(), in either order', () => {
    const schema = $t.Object({ nothing: $t.String({ default: '' }) })
    const kConfig = token<ConfigHandle<InferSchema<typeof schema>>>(Symbol('app.config'))

    const withFirst = createWebApplication(fastifyAdapterFactory(Fastify()))
      .with(probe())
      .config(schema, kConfig, c => c.source(new EnvConfigProvider()))

    const configFirst = createWebApplication(fastifyAdapterFactory(Fastify()))
      .config(schema, kConfig, c => c.source(new EnvConfigProvider()))
      .with(probe())

    expect(typeof withFirst.with).toBe('function')
    expect(typeof configFirst.with).toBe('function')
  })

  it('survives .config(), which re-parameterises the builder', async () => {
    const container = new CaffeineIoC()
    const schema = $t.Object({ nothing: $t.String({ default: '' }) })
    const kConfig = token<ConfigHandle<InferSchema<typeof schema>>>(Symbol('app.config'))

    const app = createWebApplication(fastifyAdapterFactory(Fastify()), { container })
      .config(schema, kConfig, c => c.source(new EnvConfigProvider()))
      .with(probe(t => t.capture('after-config:9092')))

    const built = app.build()
    await built.ready()

    expect(built.container.getOptional(kProbe)).toEqual({ broker: 'after-config:9092' })
  })

  it('keeps the config type flowing to features configured afterwards', () => {
    const schema = $t.Object({ app: $t.Object({ server: $t.Object({ host: $t.String(), port: $t.Number() }) }) })
    const kConfig = token<ConfigHandle<InferSchema<typeof schema>>>(Symbol('app.config'))

    const app = createWebApplication(fastifyAdapterFactory(Fastify()))
      .with(probe())
      .config(schema, kConfig, c => c.source(new EnvConfigProvider()))
      .server((s, c) => s.withConfig(c.app.server))

    expect(typeof app.build).toBe('function')
  })
})
