import { token } from '@caffeinejs/di'
import {
  ApplicationAvailability,
  type InferSchema,
  type SignalDispatcher,
  $t,
  detectSignalDispatcher,
} from '@caffeinejs/std'
import {
  CONFIG_REFRESH_LABEL,
  ConfigPriority,
  EnvConfigProvider,
  Configuration,
  InlineConfigProvider,
  type ConfigHandle,
  type ConfigProvider,
} from '@caffeinejs/std/config'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { WebApplication, createWebApplication, fastifyAdapterFactory } from '../index.js'
import { kHealthConfig } from './index.js'
import type { HealthOptions } from './options.js'
import { healthConfigSchema } from './options.js'

// The application owns the schema: it declares where the health block lives — by importing the feature's own
// schema — and `.health(h => h.config(c => c.health))` points the feature at it.
const rootSchema = $t.Object({ health: healthConfigSchema })
const kRootConfig = token<ConfigHandle<InferSchema<typeof rootSchema>>>(Symbol('app.config'))

const schema = $t.Object({
  health: $t.Object({
    drainDelay: $t.String(),
    shutdownTimeout: $t.String(),
    verbose: $t.Boolean(),
  }),
})
const kConfig = token<ConfigHandle<InferSchema<typeof schema>>>(Symbol('app.config'))

type AppConfig = InferSchema<typeof schema>

const source = (health: AppConfig['health']): InlineConfigProvider => new InlineConfigProvider({ health })

/** The resolved options, read the way the probes and the drain read them: by key, wherever they ended up. */
function healthConfig(app: WebApplication): HealthOptions {
  return app.container.get(Configuration).config(kHealthConfig)!
}

describe('HealthBuilder', () => {
  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('enables the probes just by being called', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify())).health().build()

    await app.ready()

    expect(healthConfig(app).enabled).toBe(true)
  })

  it('leaves the probes to the environment when it is never called', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify())).build()

    await app.ready()

    // No KUBERNETES_SERVICE_HOST under the test runner.
    expect(healthConfig(app).enabled).toBe(false)
  })

  it('normalizes every duration to milliseconds', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .health(h =>
        h
          .drainDelay('2s')
          .shutdownTimeout('10s')
          .terminationGracePeriod('45s')
          .indicatorTimeout('500ms')
          .probeDeadline(1_500)
          .cacheTTL('1s'),
      )
      .build()

    await app.ready()

    expect(healthConfig(app)).toMatchObject({
      drainDelayMs: 2_000,
      shutdownTimeoutMs: 10_000,
      terminationGracePeriodMs: 45_000,
      indicatorTimeoutMs: 500,
      probeDeadlineMs: 1_500,
      cacheTTLMs: 1_000,
    })
  })

  it('drives the configuration from the application config slice', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, kConfig, c => c.source(source({ drainDelay: '30ms', shutdownTimeout: '9s', verbose: true })))
      .health(h => h.config(c => c.health))
      .build()

    await app.ready()

    expect(healthConfig(app)).toMatchObject({
      enabled: true,
      drainDelayMs: 30,
      shutdownTimeoutMs: 9_000,
      verbose: true,
    })
  })

  it('layers a builder-set duration under the config source rather than conflicting with it', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, kConfig, c =>
        c.source(source({ drainDelay: '30ms', shutdownTimeout: '9s', verbose: true }), ConfigPriority.ENV),
      )
      .health(h =>
        h
          .drainDelay('10ms')
          .cacheTTL('7s')
          .config(c => c.health),
      )
      .build()

    await app.ready()

    expect(healthConfig(app)).toMatchObject({
      // The higher-priority source wins for what it declares...
      drainDelayMs: 30,
      shutdownTimeoutMs: 9_000,
      verbose: true,
      // ...and the builder value stands for what it does not.
      cacheTTLMs: 7_000,
    })
  })

  it('lets the environment override a builder-set duration with no selector at all', async () => {
    const provider = new EnvConfigProvider()

    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(rootSchema, kRootConfig, c =>
        c.source(new EnvConfigProvider({ env: { HEALTH__DRAIN_DELAY: '30ms' } }), ConfigPriority.ENV),
      )
      .health(h => h.config(c => c.health).drainDelay('10s'))
      .build()

    await app.ready()

    expect(healthConfig(app).drainDelayMs).toBe(30)
  })

  it('lets the environment switch the probes off even though .health() opted in', async () => {
    const provider = new EnvConfigProvider()

    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(rootSchema, kRootConfig, c =>
        c.source(new EnvConfigProvider({ env: { HEALTH__ENABLED: 'false' } }), ConfigPriority.ENV),
      )
      .health(h => h.config(c => c.health))
      .build()

    await app.ready()

    expect(healthConfig(app).enabled).toBe(false)
  })

  it('reads the shutdown signals from the environment as a list', async () => {
    const provider = new EnvConfigProvider()

    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(rootSchema, kRootConfig, c =>
        c.source(new EnvConfigProvider({ env: { HEALTH__SIGNALS: 'SIGTERM,SIGINT' } }), ConfigPriority.ENV),
      )
      .health(h => h.config(c => c.health).signals(['SIGTERM']))
      .build()

    await app.ready()

    // `signals` is declared `$t.List`, so this is two signals. A plain `$t.Array` would have produced one
    // signal named "SIGTERM,SIGINT", which no runtime would ever deliver.
    expect(healthConfig(app).signals).toEqual(['SIGTERM', 'SIGINT'])
  })

  it('still accepts false from the environment, the union branch that installs no handlers', async () => {
    const provider = new EnvConfigProvider()

    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(rootSchema, kRootConfig, c =>
        c.source(new EnvConfigProvider({ env: { HEALTH__SIGNALS: 'false' } }), ConfigPriority.ENV),
      )
      .health(h => h.config(c => c.health))
      .build()

    await app.ready()

    expect(healthConfig(app).signals).toBe(false)
  })

  // Health resolves without `.health()`, but off its own defaults: nothing pointed it at the block the
  // application declared, so nothing in the tree is meant for it — `.health(h => h.config(...))` is what
  // connects the two.
  it('ignores the environment when .health() was never called', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(rootSchema, kRootConfig, c =>
        c.source(new EnvConfigProvider({ env: { HEALTH__DRAIN_DELAY: '40ms' } }), ConfigPriority.ENV),
      )
      .build()

    await app.ready()

    expect(healthConfig(app).drainDelayMs).toBe(0)
  })

  it('keeps the code-only members alongside the config-driven ones', async () => {
    const warnings: string[] = []
    const dispatcher: SignalDispatcher = {
      ...detectSignalDispatcher(),
      warn: (message: string) => warnings.push(message),
    }

    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, kConfig, c =>
        c.source(source({ drainDelay: '30ms', shutdownTimeout: '9s', verbose: true }), ConfigPriority.ENV),
      )
      .health(h => h.dispatcher(dispatcher).config(c => c.health))
      .build()

    await app.ready()

    const options = healthConfig(app)
    // A function cannot travel through the config tree, so it comes off the builder instead.
    expect(options.dispatcher).toBe(dispatcher)
    expect(options.drainDelayMs).toBe(30)
  })

  it('follows a config refresh through the object it already handed out', async () => {
    let data: AppConfig['health'] = { drainDelay: '10ms', shutdownTimeout: '9s', verbose: false }
    const mutable: ConfigProvider = { id: 'mutable', reloadable: true, load: ctx => source(data).load(ctx) }

    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, kConfig, c => c.source(mutable, ConfigPriority.ENV))
      .health(h => h.config(c => c.health).cacheTTL('1s'))
      .build()

    await app.ready()

    // The reference a collaborator holds — the registry and the probe endpoint are both handed this object.
    const options = healthConfig(app)
    expect(options.verbose).toBe(false)
    expect(options.shutdownTimeoutMs).toBe(9_000)

    data = { drainDelay: '10ms', shutdownTimeout: '12s', verbose: true }
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    // Same object, refreshed values: nothing had to be re-resolved or re-registered.
    expect(healthConfig(app)).toBe(options)
    expect(options.verbose).toBe(true)
    expect(options.shutdownTimeoutMs).toBe(12_000)
    // A value nothing overrode still comes from the builder.
    expect(options.cacheTTLMs).toBe(1_000)
  })

  // The configurer installs this default behind `!container.has(ApplicationAvailability)`, and `has` now also
  // answers for keys reachable through `.extends()`. The ordinary path must still bind the application's own
  // instance: the lifecycle writes to that object, and a container-constructed one reports a state nothing
  // ever updates.
  it("binds the application's own availability, not a container-constructed one", async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify())).health().build()

    await app.ready()

    expect(app.container.get(ApplicationAvailability)).toBe(app.availability)
  })

  it('clamps a shutdown timeout that would outlive the grace period', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .health(h => h.drainDelay('50ms').shutdownTimeout('60s').terminationGracePeriod('30s'))
      .build()

    await app.ready()

    expect(healthConfig(app).shutdownTimeoutMs).toBe(27_950)
  })
})
