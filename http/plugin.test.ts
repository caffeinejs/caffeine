import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { CaffeineIoC } from '@caffeinejs/di'
import { $t, type Plugin, type Service } from '@caffeinejs/std'
import { EnvConfigProvider } from '@caffeinejs/std/config'
import { createWebApplication, fastifyAdapterFactory } from './index.js'

// A sentinel the plugin's configurer binds into the container so a test can prove the plugin rode
// the same `configure()` path as the built-in auth/authz services.
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
    configure(kit) {
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
  it('installs the plugin method and rides the configure() path into the container', async () => {
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

  it('survives .config(), which re-parameterises the builder', async () => {
    const container = new CaffeineIoC()

    // `.config()` changes one of the builder's own type arguments so features configured afterwards see a
    // typed config. Naming its own class as the return type would discard what `.extend()` merged on, and
    // the plugin's methods would vanish mid-chain — so it re-parameterises only the builder half.
    const app = createWebApplication(fastifyAdapterFactory(Fastify()), { container })
      .extend(kafka())
      .config($t.Object({ nothing: $t.Optional($t.String()) }), c => c.source(new EnvConfigProvider()))

    expect(typeof app.kafka).toBe('function')
    app.kafka('after-config:9092')

    const built = app.build()
    await built.ready()

    expect(built.container.getOptional(kKafkaSentinel)).toEqual({ broker: 'after-config:9092' })
  })

  it('works in either order around .config()', () => {
    const schema = $t.Object({ nothing: $t.Optional($t.String()) })

    const extendFirst = createWebApplication(fastifyAdapterFactory(Fastify()))
      .extend(kafka())
      .config(schema, c => c.source(new EnvConfigProvider()))

    const configFirst = createWebApplication(fastifyAdapterFactory(Fastify()))
      .config(schema, c => c.source(new EnvConfigProvider()))
      .extend(kafka())

    expect(typeof extendFirst.kafka).toBe('function')
    expect(typeof configFirst.kafka).toBe('function')
  })

  it('still refuses a method no plugin contributed, after .config() (type-level)', () => {
    const configured = createWebApplication(fastifyAdapterFactory(Fastify()))
      .config($t.Object({ nothing: $t.Optional($t.String()) }), c => c.source(new EnvConfigProvider()))

    // @ts-expect-error no plugin was supplied, so `kafka` is absent
    const missing: unknown = configured.kafka
    expect(missing).toBeUndefined()
    // The re-parameterised builder is still a builder.
    expect(typeof configured.build).toBe('function')
  })

  it('keeps the config type flowing to features configured afterwards', () => {
    const schema = $t.Object({ app: $t.Object({ server: $t.Object({ host: $t.String(), port: $t.Number() }) }) })

    const app = createWebApplication(fastifyAdapterFactory(Fastify()))
      .extend(kafka())
      .config(schema, c => c.source(new EnvConfigProvider()))
      // Typed against the schema declared above, on a builder that still carries the plugin.
      .server(s => s.config(c => c.app.server))

    expect(typeof app.build).toBe('function')
  })
})
