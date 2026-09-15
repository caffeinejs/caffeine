import { token } from '@caffeinejs/di'
import { ApplicationAvailability, newConfiguration, type InferSchema, $t } from '@caffeinejs/std'
import {
  CONFIG_REFRESH_LABEL,
  ConfigPriority,
  EnvConfigProvider,
  InlineConfigProvider,
  type ConfigHandle,
  type ConfigProvider,
} from '@caffeinejs/std/config'
import fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { WebApplication, createWebApplication, fastifyAdapterFactory } from '../index.js'
import { kHealthOptions } from './index.js'
import type { HealthOptions } from './options.js'
import { healthConfigSchema } from './options.js'

// The application owns the schema: it declares where the health block lives — by importing the feature's own
// schema — and `.health((h, c) => h.withConfig(c.health))` points the feature at it.
const rootSchema = $t.Object({ health: healthConfigSchema })
const kRootConfig = token<ConfigHandle<InferSchema<typeof rootSchema>>>(Symbol('app.config'))

const schema = $t.Object({
  health: $t.Object({
    indicatorTimeout: $t.String(),
    cacheTTL: $t.String(),
    verbose: $t.Boolean(),
  }),
})
const kConfig = token<ConfigHandle<InferSchema<typeof schema>>>(Symbol('app.config'))

type AppConfig = InferSchema<typeof schema>

const source = (health: AppConfig['health']): InlineConfigProvider => new InlineConfigProvider({ health })

/** The resolved options, read the way the probes read them: by key, wherever they ended up. */
function healthConfig(app: WebApplication): HealthOptions {
  return app.container.get(kHealthOptions)
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
    app = createWebApplication(fastifyAdapterFactory(fastify())).health()

    await app.ready()

    expect(healthConfig(app).enabled).toBe(true)
  })

  it('leaves the probes to the environment when it is never called', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))

    await app.ready()

    // No KUBERNETES_SERVICE_HOST under the test runner.
    expect(healthConfig(app).enabled).toBe(false)
  })

  // Declaring `health` in the schema is not on its own an instruction to configure the probes from it.
  it('leaves the probes on their defaults when nothing pointed them at the block', async () => {
    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(new EnvConfigProvider({ env: { HEALTH__ENABLED: 'true' } }), ConfigPriority.ENV)
      .build()
    app = createWebApplication(fastifyAdapterFactory(fastify()), { config: conf })

    await app.ready()

    expect(healthConfig(app).enabled).toBe(false)
  })

  it('normalizes every duration to milliseconds', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify())).health(h =>
      h.indicatorTimeout('500ms').probeDeadline(1_500).cacheTTL('1s'),
    )

    await app.ready()

    expect(healthConfig(app)).toMatchObject({
      indicatorTimeoutMs: 500,
      probeDeadlineMs: 1_500,
      cacheTTLMs: 1_000,
    })
  })

  it('drives the configuration from the application config slice', async () => {
    const conf = newConfiguration(schema, kConfig)
      .source(source({ indicatorTimeout: '30ms', cacheTTL: '9s', verbose: true }))
      .build()
    app = createWebApplication(fastifyAdapterFactory(fastify()), { config: conf }).health((h, c) =>
      h.withConfig(c.health),
    )

    await app.ready()

    expect(healthConfig(app)).toMatchObject({
      enabled: true,
      indicatorTimeoutMs: 30,
      cacheTTLMs: 9_000,
      verbose: true,
    })
  })

  // Per key: `cacheTTL` was named in code and stands, while everything the code left alone comes from the
  // block the callback wired.
  it('keeps a code-set duration and takes the rest from the configured block', async () => {
    const conf = newConfiguration(schema, kConfig)
      .source(source({ indicatorTimeout: '30ms', cacheTTL: '9s', verbose: true }), ConfigPriority.ENV)
      .build()
    app = createWebApplication(fastifyAdapterFactory(fastify()), { config: conf }).health((h, c) =>
      h.cacheTTL('10ms').probeDeadline('7s').withConfig(c.health),
    )

    await app.ready()

    expect(healthConfig(app)).toMatchObject({
      // Named in code, so it stands...
      cacheTTLMs: 10,
      verbose: true,
      // ...and the builder value stands for what it does not.
      probeDeadlineMs: 7_000,
    })
  })

  it('reads a duration from the environment when the code set none', async () => {
    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(new EnvConfigProvider({ env: { HEALTH__INDICATOR_TIMEOUT: '30ms' } }), ConfigPriority.ENV)
      .build()
    app = createWebApplication(fastifyAdapterFactory(fastify()), { config: conf }).health((h, c) =>
      h.withConfig(c.health),
    )

    await app.ready()

    expect(healthConfig(app).indicatorTimeoutMs).toBe(30)
  })

  it('lets the environment switch the probes off even though .health() opted in', async () => {
    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(new EnvConfigProvider({ env: { HEALTH__ENABLED: 'false' } }), ConfigPriority.ENV)
      .build()
    app = createWebApplication(fastifyAdapterFactory(fastify()), { config: conf }).health((h, c) =>
      h.withConfig(c.health),
    )

    await app.ready()

    expect(healthConfig(app).enabled).toBe(false)
  })

  it('does not follow a config refresh after the options are bound', async () => {
    let data: AppConfig['health'] = { indicatorTimeout: '30ms', cacheTTL: '9s', verbose: false }
    const mutable: ConfigProvider = { id: 'mutable', reloadable: true, load: ctx => source(data).load(ctx) }

    const conf = newConfiguration(schema, kConfig).source(mutable, ConfigPriority.ENV).build()
    app = createWebApplication(fastifyAdapterFactory(fastify()), { config: conf }).health((h, c) =>
      h.withConfig(c.health).probeDeadline('1s'),
    )

    await app.ready()

    // The reference a collaborator holds — the registry and the probe endpoint are both handed this object.
    const options = healthConfig(app)
    expect(options.verbose).toBe(false)
    expect(options.cacheTTLMs).toBe(9_000)

    data = { indicatorTimeout: '30ms', cacheTTL: '12s', verbose: true }
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    // Same object, same values: the options were read once, when the feature configured.
    expect(healthConfig(app)).toBe(options)
    expect(options.verbose).toBe(false)
    expect(options.cacheTTLMs).toBe(9_000)
    // A value nothing overrode still comes from the builder.
    expect(options.probeDeadlineMs).toBe(1_000)
  })

  // The configurer installs this default behind `!container.has(ApplicationAvailability)`, and `has` now also
  // answers for keys reachable through `.extends()`. The ordinary path must still bind the application's own
  // instance: the lifecycle writes to that object, and a container-constructed one reports a state nothing
  // ever updates.
  it("binds the application's own availability, not a container-constructed one", async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify())).health()

    await app.ready()

    expect(app.container.get(ApplicationAvailability)).toBe(app.availability)
  })
})
