import { newConfiguration } from '@caffeinejs/std'
import { CONFIG_REFRESH_LABEL, ErrConfigValidation, type InferConfig, type ConfigSource } from '@caffeinejs/std/config'
import { EnvConfigSource } from '@caffeinejs/std/config/env'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { kHealthRegistryOptions } from '@caffeinejs/std/health'
import { type InferSchema, $t } from '@caffeinejs/std/schema'
import { afterEach, describe, expect, it } from 'vitest'

import { Health, WebApplication, createWebApplication, healthProbes } from '../index.js'
import { ErrHealthConfiguration } from './errors.js'
import type { HealthConfig } from './options.js'
import { HealthProbesBuilder } from './probes_plugin.js'

describe('HealthProbesBuilder.resolve', () => {
  it('enables the probes by default, with no call at all', () => {
    expect(new HealthProbesBuilder().resolve().enabled).toBe(true)
  })

  it('lets an explicit call turn them off', () => {
    expect(new HealthProbesBuilder().enabled(false).resolve().enabled).toBe(false)
  })

  it('gates the default on the environment once .k8s() is called', () => {
    // No KUBERNETES_SERVICE_HOST under the test runner.
    expect(new HealthProbesBuilder().k8s().resolve().enabled).toBe(false)
  })

  it('drives the configuration from a configured block', () => {
    const config: Partial<HealthConfig> = { verbose: true, paths: { ready: '/health/ready' } }

    const options = new HealthProbesBuilder().config(config).resolve()

    expect(options).toMatchObject({
      enabled: true,
      verbose: true,
      paths: { ready: '/health/ready' },
    })
  })

  // Per key: `verbose` was named in code and stands, while everything the code left alone comes from the
  // block the callback wired.
  it('keeps a code-set value and takes the rest from the configured block', () => {
    const config: Partial<HealthConfig> = { verbose: false, exclude: true }

    const options = new HealthProbesBuilder().verbose().config(config).resolve()

    expect(options).toMatchObject({
      // Named in code, so it stands...
      verbose: true,
      // ...and the block stands for what the code left alone.
      exclude: true,
    })
  })

  it('lets a configured enabled win over both the fluent default and .k8s()', () => {
    const options = new HealthProbesBuilder().k8s().config({ enabled: true }).resolve()

    expect(options.enabled).toBe(true)
  })
})

describe('healthProbes() and Health()', () => {
  const rootSchema = $t.Object({
    health: $t.Object({
      enabled: $t.Optional($t.Boolean()),
      indicatorTimeout: $t.Optional($t.Duration()),
      probeDeadline: $t.Optional($t.Duration()),
      cacheTtl: $t.Optional($t.Duration()),
    }),
  })

  const schema = $t.Object({
    health: $t.Object({
      indicatorTimeout: $t.String(),
      cacheTtl: $t.String(),
      verbose: $t.Boolean(),
    }),
  })
  type AppConfig = InferSchema<typeof schema>

  const source = (health: AppConfig['health']): InlineConfigSource => new InlineConfigSource({ health })

  let app: WebApplication | undefined

  afterEach(async () => {
    if (app !== undefined) {
      await app.close()
      app = undefined
    }
  })

  it('mounts the probes just by being installed', async () => {
    app = createWebApplication().with(healthProbes())

    await app.run()

    expect((await app.fetch('/readyz')).status).toBe(200)
  })

  it('mounts nothing when never installed', async () => {
    app = createWebApplication()

    await app.bootstrap()

    expect((await app.fetch('/readyz')).status).toBe(404)
  })

  it('lets the environment switch the probes off even though installing opted in', async () => {
    const conf = newConfiguration(rootSchema)
      .source(new EnvConfigSource({ env: { HEALTH__ENABLED: 'false' } }))
      .build().config

    app = createWebApplication({ config: conf }).with(healthProbes((h, { config }) => h.config(config.health)))

    await app.bootstrap()

    expect((await app.fetch('/readyz')).status).toBe(404)
  })

  // The key has to be the one its variable folds to: spelled `cacheTTL`, no variable could reach it, and the
  // value was dropped at bootstrap() without a word.
  it('takes the cache budget from HEALTH__CACHE_TTL', async () => {
    const conf = newConfiguration(rootSchema)
      .source(new EnvConfigSource({ env: { HEALTH__CACHE_TTL: '5s' } }))
      .build().config

    app = createWebApplication({ config: conf }).install(Health((h, { config }) => h.config(config.health)))

    await app.bootstrap()

    expect(app.container.get(kHealthRegistryOptions).cacheTTLMs).toBe(5_000)
  })

  it('normalizes every budget to milliseconds and binds them for the whole application', async () => {
    app = createWebApplication().install(Health(h => h.indicatorTimeout('500ms').probeDeadline(1_500).cacheTTL('1s')))

    await app.bootstrap()

    expect(app.container.get(kHealthRegistryOptions)).toEqual({
      indicatorTimeoutMs: 500,
      probeDeadlineMs: 1_500,
      cacheTTLMs: 1_000,
    })
  })

  // Per key: `cacheTTL` was named in code and stands, while everything the code left alone comes from the
  // block the callback wired.
  it('keeps a code-set budget and takes the rest from the configured block', async () => {
    app = createWebApplication().install(
      Health(h => h.cacheTTL('10ms').config({ indicatorTimeout: '30ms', cacheTtl: '9s' })),
    )

    await app.bootstrap()

    expect(app.container.get(kHealthRegistryOptions)).toMatchObject({
      cacheTTLMs: 10,
      indicatorTimeoutMs: 30,
    })
  })

  // A bare number names no unit. Read as duration text it was 0: every indicator that awaits was cancelled on the
  // next turn, and readiness failed for the life of the process with nothing said at bootstrap().
  it('refuses a budget the environment gives as a bare number', async () => {
    const conf = newConfiguration(rootSchema)
      .source(new EnvConfigSource({ env: { HEALTH__INDICATOR_TIMEOUT: '5000' } }))
      .build().config
    const booting = createWebApplication({ config: conf })
      .with(healthProbes((h, { config }) => h.config(config.health)))
      .bootstrap()

    await expect(booting).rejects.toThrow(ErrConfigValidation)
    await expect(booting).rejects.toThrow('health.indicatorTimeout')
  })

  // Written as a duration, a 0 fails the same way, whether it comes from code or from the configuration.
  it('refuses a budget of 0', async () => {
    const conf = newConfiguration(rootSchema)
      .source(new EnvConfigSource({ env: { HEALTH__PROBE_DEADLINE: '0s' } }))
      .build().config
    const fromCode = createWebApplication()
      .install(Health(h => h.indicatorTimeout(0)))
      .bootstrap()
    const fromConfig = createWebApplication({ config: conf })
      .install(Health((h, { config }) => h.config(config.health)))
      .bootstrap()

    await expect(fromCode).rejects.toThrow(ErrHealthConfiguration)
    await expect(fromCode).rejects.toThrow('an indicator timeout of "0ms"')
    await expect(fromConfig).rejects.toThrow(ErrHealthConfiguration)
    await expect(fromConfig).rejects.toThrow('a probe deadline of "0ms"')
  })

  // Declaring `health` in the schema is not on its own an instruction to configure the probes from it.
  it('ignores the configured block unless config(...) pointed at it', async () => {
    const conf = newConfiguration(rootSchema)
      .source(new EnvConfigSource({ env: { HEALTH__ENABLED: 'false' } }))
      .build().config
    app = createWebApplication({ config: conf }).with(healthProbes())

    await app.run()

    expect((await app.fetch('/readyz')).status).toBe(200)
  })

  it('does not follow a config refresh after the options are resolved', async () => {
    let data: AppConfig['health'] = { indicatorTimeout: '30ms', cacheTtl: '9s', verbose: false }
    const mutable: ConfigSource = { name: 'mutable', live: true, load: () => source(data).load() }

    const conf = newConfiguration(schema).source(mutable).build().config
    app = createWebApplication({ config: conf }).with(healthProbes((h, { config }) => h.config(config.health)))

    await app.run()

    // Not verbose yet, so `?verbose` is ignored and the body stays the terse form.
    expect(await (await app.fetch('/readyz?verbose')).text()).toBe('ok')

    data = { indicatorTimeout: '30ms', cacheTtl: '12s', verbose: true }
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    // The options were read once, when the plugin registered — a refresh afterward does not reach them.
    expect(await (await app.fetch('/readyz?verbose')).text()).toBe('ok')
  })

  // health() reads the application's own ApplicationAvailability off the container rather than a fresh one —
  // otherwise liveness would never reflect what the application lifecycle actually does to it.
  it("reflects the application's own availability, not a container-constructed one", async () => {
    app = createWebApplication().with(healthProbes())

    await app.run()

    expect((await app.fetch('/livez')).status).toBe(200)

    app.availability.markBroken('test')

    expect((await app.fetch('/livez')).status).toBe(503)
  })
})
