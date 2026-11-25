import {
  FeatureBuilder,
  kFeatureName,
  newConfiguration,
  type Feature,
  type FeatureConfigureKit,
  type FeatureConfigurer,
} from '@caffeinejs/application'
import type { ConfigSnapshot, InferConfig } from '@caffeinejs/application/config'
import { EnvConfigSource } from '@caffeinejs/application/config/env'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { $t, type InferSchema } from '@caffeinejs/application/schema'
import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, it, expect, expectTypeOf } from 'vitest'

import { createWebApplication } from './application.js'
import { ErrConfiguration, HTTPPlugin, Router, type HTTPPluginConfigurer, type HTTPPluginFactory } from './index.js'
import { node } from './platform/node.testkit.js'

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
    const app = createWebApplication({ adapter: node(), container }).install(probe(t => t.capture('localhost:9092')))

    await app.bootstrap()

    expect(app.container.getOptional(kProbe)).toEqual({ broker: 'localhost:9092' })
  })

  it('does not add methods to the builder', () => {
    const app = createWebApplication({ adapter: node() }).install(probe())
    // @ts-expect-error features no longer contribute methods
    const missing: unknown = app.probe
    expect(missing).toBeUndefined()
  })

  it('flows the config type to features configured after construction', async () => {
    const container = new CaffeineIoC()
    const schema = $t.Object({ nothing: $t.String({ default: '' }) })
    const conf = newConfiguration(schema).source(new EnvConfigSource()).build().config

    const app = createWebApplication({ adapter: node(), container, config: conf }).install(
      probe(t => t.capture('after-config:9092')),
    )

    await app.bootstrap()

    expect(app.container.getOptional(kProbe)).toEqual({ broker: 'after-config:9092' })
  })

  it('types a feature configured after construction against the constructor-supplied config', () => {
    const schema = $t.Object({ app: $t.Object({ server: $t.Object({ host: $t.String(), port: $t.Number() }) }) })
    const conf = newConfiguration(schema).source(new EnvConfigSource()).build().config

    const app = createWebApplication({ adapter: node(), config: conf })
      .install(probe())
      .server(({ config }) => ({ listen: config.app.server }))

    expect(typeof app.bootstrap).toBe('function')
  })
})

describe('WebApplication.with()', () => {
  // The compiler already refuses these; the runtime error is for a feature smuggled past it, refused at the call
  // rather than when the factory runs.
  it('refuses a feature, naming it and pointing at .install()', () => {
    // @ts-expect-error a feature is not a plugin factory
    expect(() => createWebApplication({ adapter: node() }).with(probe())).toThrow(ErrConfiguration)
    // @ts-expect-error a feature is not a plugin factory
    expect(() => createWebApplication({ adapter: node() }).with(probe())).toThrow(
      'Cannot register feature "probe" with ".with(...)": a feature is not a server plugin',
    )
  })

  it('refuses a value that is neither a feature nor a factory', () => {
    // @ts-expect-error a plugin factory is a function
    expect(() => createWebApplication({ adapter: node() }).with({ not: 'a-plugin' })).toThrow(
      'Cannot register an HTTP plugin: expected a plugin factory function, got object',
    )
  })

  // Read naively, the feature check would throw a `TypeError` here before the refusal could name the value.
  it('refuses null and undefined the same way', () => {
    // @ts-expect-error a plugin factory is a function
    expect(() => createWebApplication({ adapter: node() }).with(null)).toThrow(
      'Cannot register an HTTP plugin: expected a plugin factory function, got null',
    )
    // @ts-expect-error a plugin factory is a function
    expect(() => createWebApplication({ adapter: node() }).with(undefined)).toThrow(
      'Cannot register an HTTP plugin: expected a plugin factory function, got undefined',
    )
  })

  // `{ register() {} }` has every member HTTPPlugin declares: the brand makes the compiler refuse it, as start-up does.
  it('refuses a factory that returns a plain object, at compile time and at start-up', async () => {
    // @ts-expect-error a plain object with a register method is not an HTTPPlugin
    const app = createWebApplication({ adapter: node() }).with(() => ({ register() {} }))

    await expect(app.bootstrap()).rejects.toThrow('only an HTTPPlugin can be installed')
    await app.close()
  })
})

describe('HTTPPlugin.name', () => {
  let registered = 0

  class Named extends HTTPPlugin {
    override readonly name = 'named'

    register(): void {
      registered++
    }
  }

  // A name is no claim to be alone: two routers may each want the same plugin.
  it('allows one named plugin on each of two routers', async () => {
    const app = createWebApplication({ adapter: node() })
      .mount(new Router('/a').with(() => new Named()).get('/', () => 'a'))
      .mount(new Router('/b').with(() => new Named()).get('/', () => 'b'))

    try {
      await app.bootstrap()
      expect(await (await app.request('/b')).text()).toBe('b')
    } finally {
      await app.close()
    }
  })

  // Registering a plugin twice is the user's to decide: both register, and nothing reconciles them.
  it('registers two plugins of one name in one scope', async () => {
    registered = 0
    const app = createWebApplication({ adapter: node() })
      .with(() => new Named())
      .with(() => new Named())

    try {
      await app.bootstrap()
      expect(registered).toBe(2)
    } finally {
      await app.close()
    }
  })
})

describe('configure callback typing', () => {
  const schema = $t.Object({ name: $t.String({ default: 'app' }) })
  type AppConfig = InferSchema<typeof schema>

  class PlainBuilder<C = unknown> extends FeatureBuilder<C> {
    readonly [kFeatureName] = 'plain-probe'
  }

  function plain<C = unknown>(configure?: FeatureConfigurer<PlainBuilder<C>, C>): Feature<C> {
    return new PlainBuilder<C>(configure as never)
  }

  class PluginSideBuilder {}

  class NoopPlugin extends HTTPPlugin {
    register(): void {}
  }

  function pluginSide<C = unknown>(configure: HTTPPluginConfigurer<PluginSideBuilder, C>): HTTPPluginFactory<C> {
    return context => {
      configure(new PluginSideBuilder(), context)
      return new NoopPlugin()
    }
  }

  // Each call shape must reach the application's configuration type rather than fall back to `unknown` — a
  // feature through its `FeatureConfigureKit` on `.install(...)`, a plugin factory's builder through its
  // `HTTPSetupContext` on `.with(...)`.
  it('types the callback against the application configuration, on either registration', () => {
    const conf = newConfiguration(schema).source(new InlineConfigSource({})).build().config

    createWebApplication({ adapter: node(), config: conf })
      .install(plain((_b, kit) => expectTypeOf(kit.config).toEqualTypeOf<ConfigSnapshot<AppConfig>>()))
      .with(pluginSide((_b, context) => expectTypeOf(context.config).toEqualTypeOf<ConfigSnapshot<AppConfig>>()))
  })
})
