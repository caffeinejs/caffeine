import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { CaffeineIoC, token } from '@caffeinejs/di'
import { $t, defineFeature, type Service } from '@caffeinejs/std'
import { EnvConfigProvider } from '@caffeinejs/std/config'
import { createWebApplication, fastifyAdapterFactory } from './index.js'

// A sentinel the feature's configurer binds into the container so a test can prove the feature rode
// the same `bootstrap()` path as the built-in auth/authz services.
const kProbe = token<any>(Symbol('probe-sentinel'))

function probe() {
  return defineFeature<{ capture(broker: string): void }>({
    name: 'probe',
    singleton: true,
    install(ctx, configure) {
      const state: { broker: string | undefined } = { broker: undefined }
      const service: Service = {
        get name() {
          return 'probe'
        },
        bootstrap(kit) {
          kit.container.bind(kProbe, t => t.toValue({ broker: state.broker }))
          return Promise.resolve()
        },
      }
      ctx.addService(service)
      configure?.({
        capture(broker: string) {
          state.broker = broker
        },
      })
    },
  })
}

describe('builder.extend()', () => {
  it('installs the feature and rides the bootstrap path into the container', async () => {
    const container = new CaffeineIoC()
    const app = createWebApplication(fastifyAdapterFactory(Fastify()), { container })
      .extend(probe(), t => t.capture('localhost:9092'))

    const built = app.build()
    await built.ready()

    expect(built.container.getOptional(kProbe)).toEqual({ broker: 'localhost:9092' })
  })

  it('does not add methods to the builder', () => {
    const app = createWebApplication(fastifyAdapterFactory(Fastify()), {})
      .extend(probe())
    // @ts-expect-error features no longer contribute methods
    const missing: unknown = app.probe
    expect(missing).toBeUndefined()
  })

  it('keeps .extend available across .config(), in either order', () => {
    const schema = $t.Object({ nothing: $t.Optional($t.String()) })

    const extendFirst = createWebApplication(fastifyAdapterFactory(Fastify()))
      .extend(probe())
      .config(schema, c => c.source(new EnvConfigProvider()))

    const configFirst = createWebApplication(fastifyAdapterFactory(Fastify()))
      .config(schema, c => c.source(new EnvConfigProvider()))
      .extend(probe())

    expect(typeof extendFirst.extend).toBe('function')
    expect(typeof configFirst.extend).toBe('function')
  })

  it('survives .config(), which re-parameterises the builder', async () => {
    const container = new CaffeineIoC()

    const app = createWebApplication(fastifyAdapterFactory(Fastify()), { container })
      .config($t.Object({ nothing: $t.Optional($t.String()) }), c => c.source(new EnvConfigProvider()))
      .extend(probe(), t => t.capture('after-config:9092'))

    const built = app.build()
    await built.ready()

    expect(built.container.getOptional(kProbe)).toEqual({ broker: 'after-config:9092' })
  })

  it('keeps the config type flowing to features configured afterwards', () => {
    const schema = $t.Object({ app: $t.Object({ server: $t.Object({ host: $t.String(), port: $t.Number() }) }) })

    const app = createWebApplication(fastifyAdapterFactory(Fastify()))
      .extend(probe())
      .config(schema, c => c.source(new EnvConfigProvider()))
      .server(s => s.config(c => c.app.server))

    expect(typeof app.build).toBe('function')
  })
})
