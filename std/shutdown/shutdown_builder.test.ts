import { CaffeineIoC, token } from '@caffeinejs/di'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CONFIG_REFRESH_LABEL,
  EnvConfigSource,
  ErrConfigValidation,
  InlineConfigSource,
  type ConfigDefinition,
  type ConfigSource,
  type InferConfig,
} from '../config/index.js'
import { createApplication, newConfiguration } from '../index.js'
import { $t } from '../schema/t.js'
import { kShutdownPolicy, shutdownConfigSchema, type ShutdownOptions } from './shutdown_options.js'
import { noopSignalDispatcher, type SignalDispatcher } from './signals.js'

const appSchema = $t.Object({ shutdown: shutdownConfigSchema })
type AppConfig = InferConfig<typeof appSchema>
const kAppConfig = token<AppConfig>(Symbol('app.config'))

const headless = (config?: ConfigDefinition<AppConfig>) =>
  createApplication({ container: new CaffeineIoC({ decorators: false }), config })

function policyOf(app: { container: { get(t: typeof kShutdownPolicy): ShutdownOptions } }): ShutdownOptions {
  return app.container.get(kShutdownPolicy)
}

describe('ShutdownBuilder', () => {
  it('is registered unconditionally and resolves detached off the defaults', async () => {
    const app = headless()
    await app.ready()

    const policy = policyOf(app)
    expect(policy.drainDelayMs).toBe(0)
    // The suite is a test runner — the one case where the default is not ['SIGTERM', 'SIGINT'].
    expect(policy.signals).toBe(false)
    expect(policy.terminationGracePeriodMs).toBe(30_000)
  })

  // Declaring `shutdown` in the schema is not on its own an instruction to configure the drain from it.
  it('leaves the drain on its defaults when nothing pointed it at the block', async () => {
    const conf = newConfiguration(appSchema, kAppConfig)
      .source(new EnvConfigSource({ env: { SHUTDOWN__DRAIN_DELAY: '40ms' } }))
      .build()
    const app = headless(conf)
    await app.ready()

    expect(policyOf(app).drainDelayMs).toBe(0)
    await app.close()
  })

  // A fluent method is the last word: the callback wired the block, but `drainDelay` was also set in code,
  // so the code value is what the drain runs on.
  it('takes a fluent value over the configured one', async () => {
    const conf = newConfiguration(appSchema, kAppConfig)
      .source(new InlineConfigSource({ shutdown: { drainDelay: '90ms' } }))
      .build()
    const app = headless(conf).shutdown((s, { config }) => s.drainDelay('10s').config(config.shutdown))
    await app.ready()

    expect(policyOf(app).drainDelayMs).toBe(10_000)
  })

  it('reads durations and the signal list from the environment', async () => {
    const conf = newConfiguration(appSchema, kAppConfig)
      .source(
        new EnvConfigSource({
          env: { SHUTDOWN__DRAIN_DELAY: '40ms', SHUTDOWN__SIGNALS: 'SIGTERM,SIGINT' },
        }),
      )
      .build()
    const app = headless(conf).shutdown((s, { config }) => s.config(config.shutdown))
    await app.ready()

    const policy = policyOf(app)
    expect(policy.drainDelayMs).toBe(40)
    // `$t.List`, so the comma-separated value is two signals, not one with a comma in its name.
    expect(policy.signals).toEqual(['SIGTERM', 'SIGINT'])
  })

  // A bare number names no unit. Read as duration text it was 0, and a timeout of 0 waits indefinitely, so the
  // orchestrator's SIGKILL was all that ended a stuck shutdown.
  it('refuses a duration the environment gives as a bare number', async () => {
    const conf = newConfiguration(appSchema, kAppConfig)
      .source(new EnvConfigSource({ env: { SHUTDOWN__SHUTDOWN_TIMEOUT: '10000' } }))
      .build()
    const app = headless(conf).shutdown((s, { config }) => s.config(config.shutdown))
    const booting = app.ready()

    await expect(booting).rejects.toThrow(ErrConfigValidation)
    await expect(booting).rejects.toThrow('shutdown.shutdownTimeout')
  })

  it('keeps the dispatcher on the builder — a function cannot travel the config tree', async () => {
    const conf = newConfiguration(appSchema, kAppConfig)
      .source(new InlineConfigSource({ shutdown: { drainDelay: '30ms' } }))
      .build()
    const app = headless(conf).shutdown((s, { config }) => s.dispatcher(noopSignalDispatcher).config(config.shutdown))
    await app.ready()

    const policy = policyOf(app)
    expect(policy.dispatcher).toBe(noopSignalDispatcher)
    expect(policy.drainDelayMs).toBe(30)
  })

  it('does not follow a config refresh after the policy is bound', async () => {
    let shutdownTimeout = '9s'
    const changing: ConfigSource = {
      name: 'shutdown-test',
      live: true,
      load: () => [{ name: 'shutdown-test', data: { shutdown: { shutdownTimeout } } }],
    }

    const conf = newConfiguration(appSchema, kAppConfig).source(changing).build()
    const app = headless(conf).shutdown((s, { config }) => s.config(config.shutdown))
    await app.ready()

    const policy = policyOf(app)
    expect(policy.shutdownTimeoutMs).toBe(9_000)

    shutdownTimeout = '12s'
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    // The policy was read once, when the feature configured: a later refresh does not reach it.
    expect(policyOf(app)).toBe(policy)
    expect(policy.shutdownTimeoutMs).toBe(9_000)
  })

  it('clamps a shutdown timeout that would outlive the grace period', async () => {
    const app = headless().shutdown(s => s.drainDelay('5s').shutdownTimeout('60s').terminationGracePeriod('30s'))
    await app.ready()

    expect(policyOf(app).shutdownTimeoutMs).toBe(23_000)
  })

  it('rejects at ready() when the drain delay cannot fit the grace period at all', async () => {
    const app = headless().shutdown(s => s.drainDelay('30s').terminationGracePeriod('20s'))

    await expect(app.ready()).rejects.toThrow('does not fit in a termination grace period')
  })

  it('installs a real signal handler when signals are set explicitly, even under the test runner', async () => {
    const before = process.listenerCount('SIGTERM')

    const app = headless().shutdown(s => s.signals(['SIGTERM']).drainDelay(0))
    await app.run()

    expect(process.listenerCount('SIGTERM')).toBe(before + 1)

    await app.close()

    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})

// Under Kubernetes a drain delay of 0 drops requests on every rolling deploy, but only for an application a Service
// routes to. Set in code, the 0 is a decision about one nothing routes to; from the configuration it is as likely a
// copied environment, so only that one is warned about.
describe('the zero-drain warning under Kubernetes', () => {
  beforeEach(() => {
    vi.stubEnv('KUBERNETES_SERVICE_HOST', '10.0.0.1')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function recording(): { dispatcher: SignalDispatcher; warnings: string[] } {
    const warnings: string[] = []

    return { dispatcher: { ...noopSignalDispatcher, warn: message => void warnings.push(message) }, warnings }
  }

  const configured = (drainDelay: string) =>
    newConfiguration(appSchema, kAppConfig)
      .source(new EnvConfigSource({ env: { SHUTDOWN__DRAIN_DELAY: drainDelay } }))
      .build()

  it('says nothing about a 0 set in code', async () => {
    const { dispatcher, warnings } = recording()
    const app = headless().shutdown(s => s.dispatcher(dispatcher).drainDelay(0))
    await app.ready()

    expect(warnings).toEqual([])
    await app.close()
  })

  it('warns about a 0 from the configuration', async () => {
    const { dispatcher, warnings } = recording()
    const app = headless(configured('0s')).shutdown((s, { config }) => s.dispatcher(dispatcher).config(config.shutdown))
    await app.ready()

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('from the configuration')
    await app.close()
  })

  it('says nothing when code sets 0 over a configured delay', async () => {
    const { dispatcher, warnings } = recording()
    const app = headless(configured('5s')).shutdown((s, { config }) =>
      s.dispatcher(dispatcher).config(config.shutdown).drainDelay(0),
    )
    await app.ready()

    expect(policyOf(app).drainDelayMs).toBe(0)
    expect(warnings).toEqual([])
    await app.close()
  })

  it('says nothing when code sets a delay over a configured 0', async () => {
    const { dispatcher, warnings } = recording()
    const app = headless(configured('0s')).shutdown((s, { config }) =>
      s.dispatcher(dispatcher).config(config.shutdown).drainDelay('5s'),
    )
    await app.ready()

    expect(policyOf(app).drainDelayMs).toBe(5_000)
    expect(warnings).toEqual([])
    await app.close()
  })
})
