import { token } from '@caffeinejs/di'
import { newConfiguration } from '@caffeinejs/std'
import {
  CONFIG_REFRESH_LABEL,
  EnvConfigSource,
  InlineConfigSource,
  type InferConfig,
  type ConfigSource,
} from '@caffeinejs/std/config'
import { kHealthRegistryOptions } from '@caffeinejs/std/health'
import { type InferSchema, $t } from '@caffeinejs/std/schema'
import { afterEach, describe, expect, it } from 'vitest'

import { WebApplication, createWebApplication } from '../index.js'
import { HealthBuilder } from './builder.js'
import { health } from './health.js'
import { healthConfigSchema, type HealthConfig } from './options.js'

describe('HealthBuilder.resolve', () => {
  it('enables the probes by default, with no call at all', () => {
    expect(new HealthBuilder().resolve().enabled).toBe(true)
  })

  it('lets an explicit call turn them off', () => {
    expect(new HealthBuilder().enabled(false).resolve().enabled).toBe(false)
  })

  it('gates the default on the environment once .k8s() is called', () => {
    // No KUBERNETES_SERVICE_HOST under the test runner.
    expect(new HealthBuilder().k8s().resolve().enabled).toBe(false)
  })

  it('normalizes every duration to milliseconds', () => {
    const options = new HealthBuilder().indicatorTimeout('500ms').probeDeadline(1_500).cacheTTL('1s').resolve()

    expect(options).toMatchObject({
      indicatorTimeoutMs: 500,
      probeDeadlineMs: 1_500,
      cacheTTLMs: 1_000,
    })
  })

  it('drives the configuration from a configured block', () => {
    const config: Partial<HealthConfig> = { indicatorTimeout: '30ms', cacheTtl: '9s', verbose: true }

    const options = new HealthBuilder().config(config).resolve()

    expect(options).toMatchObject({
      enabled: true,
      indicatorTimeoutMs: 30,
      cacheTTLMs: 9_000,
      verbose: true,
    })
  })

  // Per key: `cacheTTL` was named in code and stands, while everything the code left alone comes from the
  // block the callback wired.
  it('keeps a code-set duration and takes the rest from the configured block', () => {
    const config: Partial<HealthConfig> = { indicatorTimeout: '30ms', cacheTtl: '9s', verbose: true }

    const options = new HealthBuilder().cacheTTL('10ms').probeDeadline('7s').config(config).resolve()

    expect(options).toMatchObject({
      // Named in code, so it stands...
      cacheTTLMs: 10,
      verbose: true,
      // ...and the builder value stands for what it does not.
      probeDeadlineMs: 7_000,
    })
  })

  it('lets a configured enabled win over both the fluent default and .k8s()', () => {
    const options = new HealthBuilder().k8s().config({ enabled: true }).resolve()

    expect(options.enabled).toBe(true)
  })
})

describe('health()', () => {
  const rootSchema = $t.Object({ health: healthConfigSchema })
  const kRootConfig = token<InferConfig<typeof rootSchema>>(Symbol('app.config'))

  const schema = $t.Object({
    health: $t.Object({
      indicatorTimeout: $t.String(),
      cacheTtl: $t.String(),
      verbose: $t.Boolean(),
    }),
  })
  const kConfig = token<InferConfig<typeof schema>>(Symbol('app.config'))
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
    app = createWebApplication().with(health())

    await app.run()

    expect((await app.fetch('/readyz')).status).toBe(200)
  })

  it('mounts nothing when never installed', async () => {
    app = createWebApplication()

    await app.ready()

    expect((await app.fetch('/readyz')).status).toBe(404)
  })

  it('lets the environment switch the probes off even though installing opted in', async () => {
    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(new EnvConfigSource({ env: { HEALTH__ENABLED: 'false' } }))
      .build()

    app = createWebApplication({ config: conf }).with(health((h, { config }) => h.config(config.health)))

    await app.ready()

    expect((await app.fetch('/readyz')).status).toBe(404)
  })

  // The key has to be the one its variable folds to: spelled `cacheTTL`, no variable could reach it, and the
  // value was dropped at ready() without a word.
  it('takes the cache budget from HEALTH__CACHE_TTL', async () => {
    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(new EnvConfigSource({ env: { HEALTH__CACHE_TTL: '5s' } }))
      .build()

    app = createWebApplication({ config: conf }).with(health((h, { config }) => h.config(config.health)))

    await app.ready()

    expect(app.container.get(kHealthRegistryOptions).cacheTTLMs).toBe(5_000)
  })

  // Declaring `health` in the schema is not on its own an instruction to configure the probes from it.
  it('ignores the configured block unless config(...) pointed at it', async () => {
    const conf = newConfiguration(rootSchema, kRootConfig)
      .source(new EnvConfigSource({ env: { HEALTH__ENABLED: 'false' } }))
      .build()
    app = createWebApplication({ config: conf }).with(health())

    await app.run()

    expect((await app.fetch('/readyz')).status).toBe(200)
  })

  it('does not follow a config refresh after the options are resolved', async () => {
    let data: AppConfig['health'] = { indicatorTimeout: '30ms', cacheTtl: '9s', verbose: false }
    const mutable: ConfigSource = { name: 'mutable', live: true, load: () => source(data).load() }

    const conf = newConfiguration(schema, kConfig).source(mutable).build()
    app = createWebApplication({ config: conf }).with(health((h, { config }) => h.config(config.health)))

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
    app = createWebApplication().with(health())

    await app.run()

    expect((await app.fetch('/livez')).status).toBe(200)

    app.availability.markBroken('test')

    expect((await app.fetch('/livez')).status).toBe(503)
  })
})
