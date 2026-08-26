import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { CaffeineIoC } from '@caffeinejs/di'
import { $t, kServiceConfigure, type Plugin, type Service } from '@caffeinejs/std'
import { EnvProvider } from '@caffeinejs/std/config'
import { createWebApplication, fastifyAdapterFactory } from './index.js'

// A sentinel the plugin's configurer binds into the container so a test can prove the plugin rode
// the same `[kServiceConfigure]` path as the built-in auth/authz services.
const kKafkaSentinel = Symbol('kafka-sentinel')

interface KafkaState {
  broker: string | undefined
}

// Illustrative plugin. `Name` is a `const` string-literal param so a caller can rename the method and
// the typing follows (see the rename test). It contributes one flat method that captures config, and
// registers a Service that binds the captured config at ready() time.
function kafka<const Name extends string = 'kafka'>(
  name: Name = 'kafka' as Name,
): Plugin<Record<Name, (broker: string) => void>> {
  const state: KafkaState = { broker: undefined }
  const service: Service = {
    [kServiceConfigure](kit) {
      kit.container.bind(kKafkaSentinel).toValue({ broker: state.broker })
      return Promise.resolve()
    },
  }

  return {
    name,
    install(ctx) {
      ctx.addService(service)
      const configure = (broker: string): void => {
        state.broker = broker
      }
      const methods = { [name]: configure }
      return methods as Record<Name, (broker: string) => void>
    },
  }
}

describe('builder.extend()', () => {
  it('installs the plugin method and rides the [kServiceConfigure] path into the container', async () => {
    const container = new CaffeineIoC()
    const app = createWebApplication(fastifyAdapterFactory(Fastify()), { container })
      .extend(kafka())

    expect(typeof app.kafka).toBe('function')
    app.kafka('localhost:9092')

    const built = app.build()
    await built.ready()

    // The configurer ran and bound the captured config — proof the user plugin was wired like a
    // first-class service.
    expect(built.container.getOptional(kKafkaSentinel)).toEqual({ broker: 'localhost:9092' })
  })

  it('honours a caller-supplied method name, keeping the typing', async () => {
    const app = createWebApplication(fastifyAdapterFactory(Fastify()), {})
      .extend(kafka('kafkaB'))

    expect(typeof app.kafkaB).toBe('function')
    app.kafkaB('broker:1')

    // @ts-expect-error the default `kafka` name is gone once renamed to `kafkaB`
    const gone: unknown = app.kafka
    expect(gone).toBeUndefined()
  })

  it('merges multiple plugins without collision', () => {
    const app = createWebApplication(fastifyAdapterFactory(Fastify()), {})
      .extend(kafka('a'), kafka('b'))
    expect(typeof app.a).toBe('function')
    expect(typeof app.b).toBe('function')
  })

  it('does not expose undeclared methods (type-level)', () => {
    const app = createWebApplication(fastifyAdapterFactory(Fastify()), {})
      .extend(kafka())
    // @ts-expect-error `nope` is not contributed by any plugin
    const bad: unknown = app.nope
    expect(bad).toBeUndefined()
  })

  it('types a plugin-less builder as a plain builder (no augmentation)', () => {
    const app = createWebApplication(fastifyAdapterFactory(Fastify()))
    // @ts-expect-error no plugin was supplied, so `kafka` is absent
    const bad: unknown = app.kafka
    expect(bad).toBeUndefined()
    // Sanity: the plain builder still exposes its normal surface.
    expect(typeof app.build).toBe('function')
  })

  it('can be called at any point, and again after .config() re-types the builder', async () => {
    const container = new CaffeineIoC()

    // `.config()` returns a builder re-typed to carry the config type, which drops the plugin augments
    // from the type. Extending again restores them — the reason `.extend()` is a method and not a
    // factory argument.
    const configured = createWebApplication(fastifyAdapterFactory(Fastify()), { container })
      .config($t.Object({ nothing: $t.Optional($t.String()) }), c => c.source(new EnvProvider()))

    // @ts-expect-error the augments did not survive the re-type
    const gone: unknown = configured.kafka
    expect(gone).toBeUndefined()

    const app = configured.extend(kafka())
    expect(typeof app.kafka).toBe('function')
    app.kafka('after-config:9092')

    const built = app.build()
    await built.ready()

    expect(built.container.getOptional(kKafkaSentinel)).toEqual({ broker: 'after-config:9092' })
  })
})
