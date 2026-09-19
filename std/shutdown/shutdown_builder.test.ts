import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import {
  CONFIG_REFRESH_LABEL,
  EnvConfigSource,
  InlineConfigSource,
  type ConfigDefinition,
  type ConfigSource,
  type InferConfig,
} from '../config/index.js'
import { $t, createApplication, newConfiguration } from '../index.js'
import { kShutdownPolicy, shutdownConfigSchema, type ShutdownOptions } from './shutdown_options.js'
import { noopSignalDispatcher } from './signals.js'

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
    const app = headless(conf).shutdown((s, c) => s.drainDelay('10s').config(c.shutdown))
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
    const app = headless(conf).shutdown((s, c) => s.config(c.shutdown))
    await app.ready()

    const policy = policyOf(app)
    expect(policy.drainDelayMs).toBe(40)
    // `$t.List`, so the comma-separated value is two signals, not one with a comma in its name.
    expect(policy.signals).toEqual(['SIGTERM', 'SIGINT'])
  })

  it('keeps the dispatcher on the builder — a function cannot travel the config tree', async () => {
    const conf = newConfiguration(appSchema, kAppConfig)
      .source(new InlineConfigSource({ shutdown: { drainDelay: '30ms' } }))
      .build()
    const app = headless(conf).shutdown((s, c) => s.dispatcher(noopSignalDispatcher).config(c.shutdown))
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
    const app = headless(conf).shutdown((s, c) => s.config(c.shutdown))
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
