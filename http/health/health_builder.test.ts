import { afterEach, describe, expect, it } from 'vitest'
import fastify from 'fastify'
import { ErrConfigSourceConflict, type InferSchema, $t } from '@caffeinejs/std'
import { InlineProvider } from '@caffeinejs/std/config'
import { WebApplication, createWebApplication, fastifyAdapterFactory } from '../index.js'
import { kHealthOptions, type HealthOptions } from './index.js'

const schema = $t.Object({
  health: $t.Object({
    drainDelay: $t.String(),
    shutdownTimeout: $t.String(),
    verbose: $t.Boolean(),
  }),
})

type AppConfig = InferSchema<typeof schema>

const source = (health: AppConfig['health']): InlineProvider => new InlineProvider({ health })

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

    expect(app.container.get<HealthOptions>(kHealthOptions).enabled).toBe(true)
  })

  it('leaves the probes to the environment when it is never called', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify())).build()

    await app.ready()

    // No KUBERNETES_SERVICE_HOST under the test runner.
    expect(app.container.get<HealthOptions>(kHealthOptions).enabled).toBe(false)
  })

  it('normalizes every duration to milliseconds', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .health(h => h
        .drainDelay('2s')
        .shutdownTimeout('10s')
        .terminationGracePeriod('45s')
        .indicatorTimeout('500ms')
        .probeDeadline(1_500)
        .cacheTTL('1s'))
      .build()

    await app.ready()

    expect(app.container.get<HealthOptions>(kHealthOptions)).toMatchObject({
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
      .config(schema, c => c.source(source({ drainDelay: '30ms', shutdownTimeout: '9s', verbose: true })))
      .health(h => h.config(c => c.health))
      .build()

    await app.ready()

    expect(app.container.get<HealthOptions>(kHealthOptions)).toMatchObject({
      enabled: true,
      drainDelayMs: 30,
      shutdownTimeoutMs: 9_000,
      verbose: true,
    })
  })

  it('throws ErrConfigSourceConflict when both sources are used', async () => {
    const built = createWebApplication(fastifyAdapterFactory(fastify()))
      .config(schema, c => c.source(source({ drainDelay: '30ms', shutdownTimeout: '9s', verbose: true })))
      .health(h => h.drainDelay('10ms').config(c => c.health))
      .build()

    await expect(built.ready()).rejects.toThrow(ErrConfigSourceConflict)
  })

  it('clamps a shutdown timeout that would outlive the grace period', async () => {
    app = createWebApplication(fastifyAdapterFactory(fastify()))
      .health(h => h.drainDelay('50ms').shutdownTimeout('60s').terminationGracePeriod('30s'))
      .build()

    await app.ready()

    expect(app.container.get<HealthOptions>(kHealthOptions).shutdownTimeoutMs).toBe(27_950)
  })
})
