import { CaffeineIoC, token } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import {
  CONFIG_REFRESH_LABEL,
  ConfigPriority,
  EnvConfigProvider,
  InlineConfigProvider,
  MutableConfigProvider,
  type ConfigHandle,
} from '../config/index.js'
import { type InferSchema, $t, createApplication } from '../index.js'
import { kShutdownPolicy, shutdownConfigSchema, type ShutdownOptions } from './shutdown_options.js'
import { noopSignalDispatcher } from './signals.js'

const appSchema = $t.Object({ shutdown: shutdownConfigSchema })
const kAppConfig = token<ConfigHandle<InferSchema<typeof appSchema>>>(Symbol('app.config'))

const headless = () => createApplication({ container: new CaffeineIoC({ decorators: false }) })

function policyOf(app: { container: { get(t: typeof kShutdownPolicy): ShutdownOptions } }): ShutdownOptions {
  return app.container.get(kShutdownPolicy)
}

describe('ShutdownBuilder', () => {
  it('is registered unconditionally and resolves detached off the defaults', async () => {
    const app = headless().build()
    await app.ready()

    const policy = policyOf(app)
    expect(policy.drainDelayMs).toBe(0)
    // The suite is a test runner — the one case where the default is not ['SIGTERM', 'SIGINT'].
    expect(policy.signals).toBe(false)
    expect(policy.terminationGracePeriodMs).toBe(30_000)
  })

  it('takes a fluent value as a default the configuration tree can still override', async () => {
    const app = headless()
      .config(appSchema, kAppConfig, c => c.source(new InlineConfigProvider({ shutdown: { drainDelay: '90ms' } })))
      .shutdown(s => s.drainDelay('10s').config(c => c.shutdown))
      .build()
    await app.ready()

    expect(policyOf(app).drainDelayMs).toBe(90)
  })

  it('reads durations and the signal list from the environment', async () => {
    const app = headless()
      .config(appSchema, kAppConfig, c =>
        c.source(
          new EnvConfigProvider({
            env: { SHUTDOWN__DRAIN_DELAY: '40ms', SHUTDOWN__SIGNALS: 'SIGTERM,SIGINT' },
          }),
          ConfigPriority.ENV,
        ),
      )
      .shutdown(s => s.config(c => c.shutdown).signals(['SIGTERM']))
      .build()
    await app.ready()

    const policy = policyOf(app)
    expect(policy.drainDelayMs).toBe(40)
    // `$t.List`, so the comma-separated value is two signals, not one with a comma in its name.
    expect(policy.signals).toEqual(['SIGTERM', 'SIGINT'])
  })

  it('keeps the dispatcher on the builder — a function cannot travel the config tree', async () => {
    const app = headless()
      .config(appSchema, kAppConfig, c => c.source(new InlineConfigProvider({ shutdown: { drainDelay: '30ms' } })))
      .shutdown(s => s.dispatcher(noopSignalDispatcher).config(c => c.shutdown))
      .build()
    await app.ready()

    const policy = policyOf(app)
    expect(policy.dispatcher).toBe(noopSignalDispatcher)
    expect(policy.drainDelayMs).toBe(30)
  })

  it('follows a config refresh through the object it already handed out', async () => {
    const mutable = new MutableConfigProvider('shutdown-test')
    mutable.set('shutdown', { shutdownTimeout: '9s' })

    const app = headless()
      .config(appSchema, kAppConfig, c => c.source(mutable, ConfigPriority.ENV))
      .shutdown(s => s.config(c => c.shutdown))
      .build()
    await app.ready()

    const policy = policyOf(app)
    expect(policy.shutdownTimeoutMs).toBe(9_000)

    mutable.set('shutdown', { shutdownTimeout: '12s' })
    await app.container.refresher.refresh(CONFIG_REFRESH_LABEL as symbol)

    expect(policyOf(app)).toBe(policy)
    expect(policy.shutdownTimeoutMs).toBe(12_000)
  })

  it('clamps a shutdown timeout that would outlive the grace period', async () => {
    const app = headless()
      .shutdown(s => s.drainDelay('5s').shutdownTimeout('60s').terminationGracePeriod('30s'))
      .build()
    await app.ready()

    expect(policyOf(app).shutdownTimeoutMs).toBe(23_000)
  })

  it('rejects at ready() when the drain delay cannot fit the grace period at all', async () => {
    const app = headless()
      .shutdown(s => s.drainDelay('30s').terminationGracePeriod('20s'))
      .build()

    await expect(app.ready()).rejects.toThrow('does not fit in a termination grace period')
  })

  it('installs a real signal handler when signals are set explicitly, even under the test runner', async () => {
    const before = process.listenerCount('SIGTERM')

    const app = headless()
      .shutdown(s => s.signals(['SIGTERM']).drainDelay(0))
      .build()
    await app.run()

    expect(process.listenerCount('SIGTERM')).toBe(before + 1)

    await app.close()

    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})
