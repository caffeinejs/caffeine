import { createApplication, newConfiguration } from '@caffeinejs/application'
import { ErrConfigValidation, type ConfigSource } from '@caffeinejs/application/config'
import { EnvConfigSource } from '@caffeinejs/application/config/env'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { $t, type InferSchema } from '@caffeinejs/application/schema'
import { CaffeineIoC } from '@caffeinejs/di'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ResilienceConfigSchema } from './_spectypes/index.js'
import { Resilience, type ResilienceBuilder } from './aop/feature.js'
import { ResilienceRegistry } from './aop/registry.js'
import { fakeTimersClock } from './clock.testkit.js'
import { run } from './compose.js'
import { ErrRateLimitExceeded } from './ratelimiter/ratelimiter.js'

const appConfigSchema = $t.Object(
  { resilience: $t.Object(ResilienceConfigSchema.properties, { default: {} }) },
  { default: {} },
)

type AppConfig = InferSchema<typeof appConfigSchema>

const opened: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const close of opened.splice(0)) {
    await close()
  }
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Boots an application whose configuration comes from `source`, with the resilience block handed to the feature and
// whatever `define` adds in code over it.
async function registryFrom(
  source: ConfigSource,
  define: (r: ResilienceBuilder<AppConfig>) => ResilienceBuilder<AppConfig> = r => r,
): Promise<ResilienceRegistry> {
  const config = newConfiguration(appConfigSchema).source(source).build().config
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config }).install(
    Resilience<AppConfig>((r, { config }) => define(r.config(config.resilience))),
  )
  opened.push(() => app.close())
  await app.bootstrap()
  return app.container.get(ResilienceRegistry)
}

describe('resilience configuration', () => {
  // Configuration writes durations as text: the instance must run on what the text says, in milliseconds.
  it('decodes a duration written as text into the instance it defines', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const registry = await registryFrom(
      new InlineConfigSource({
        resilience: { presets: { partner: { rateLimiter: { limitForPeriod: 1, limitRefreshPeriod: '1500ms' } } } },
      }),
      r => r.preset('partner', p => p.rateLimiter({ clock: fakeTimersClock })),
    )
    const quota = registry.rateLimiter('partner')

    await run(quota.wrap(async () => 'ok'))
    const refused = await run(quota.wrap(async () => 'ok')).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(ErrRateLimitExceeded)
    expect((refused as ErrRateLimitExceeded).retryAfter).toBe(1_500)
  })

  // A bare number has no unit: is 150 milliseconds or seconds? The deployment fails rather than guess.
  it('refuses a duration written as a bare number at bootstrap', async () => {
    const error = await registryFrom(
      new InlineConfigSource({ resilience: { presets: { inventory: { timeLimiter: { timeoutDuration: '150' } } } } }),
    ).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrConfigValidation)
  })

  it('refuses an option out of range at bootstrap', async () => {
    const error = await registryFrom(
      new InlineConfigSource({ resilience: { presets: { exports: { bulkhead: { maxConcurrentCalls: 0 } } } } }),
    ).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrConfigValidation)
  })

  // An operator defines or retunes a preset with an environment variable alone, by name.
  it('defines a preset from an environment variable, its name a key of the record', async () => {
    vi.stubEnv('APP_RESILIENCE__PRESETS__INVENTORY__RETRY__MAX_ATTEMPTS', '5')
    vi.stubEnv('APP_RESILIENCE__PRESETS__INVENTORY__RETRY__BACKOFF__TYPE', 'fixed')
    vi.stubEnv('APP_RESILIENCE__PRESETS__INVENTORY__RETRY__BACKOFF__DELAY', '0s')
    const registry = await registryFrom(new EnvConfigSource({ prefix: 'APP_' }))
    let attempts = 0

    await run(
      registry.retry('inventory').wrap(async () => {
        attempts++
        throw new Error('down')
      }),
    ).catch(() => undefined)

    expect(attempts).toBe(5)
  })
})

describe('configured defaults', () => {
  it('tunes every preset that defines the policy from one environment variable', async () => {
    vi.stubEnv('APP_RESILIENCE__DEFAULTS__RETRY__MAX_ATTEMPTS', '4')
    const registry = await registryFrom(new EnvConfigSource({ prefix: 'APP_' }), r =>
      r.preset('inventory', p => p.retry({ backoff: 0 })),
    )
    let attempts = 0

    await run(
      registry.retry('inventory').wrap(async () => {
        attempts++
        throw new Error('down')
      }),
    ).catch(() => undefined)

    expect(attempts).toBe(4)
  })
})

describe('a configured backoff', () => {
  // The delays a retry of three attempts waits, driven on the fake clock.
  async function delaysOf(registry: ResilienceRegistry): Promise<number[]> {
    const delays: number[] = []
    registry.retry('inventory').on('retry', e => delays.push(e.delay))
    const call = run(
      registry.retry('inventory').wrap(async () => {
        throw new Error('down')
      }),
    ).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(10_000)
    await call
    return delays
  }

  // An exponential backoff spreads its waits, or every client retries in step; configuring one must keep that.
  it('builds an exponential backoff from the environment, keeping the default jitter', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.stubEnv('APP_RESILIENCE__PRESETS__INVENTORY__RETRY__BACKOFF__TYPE', 'exponential')
    vi.stubEnv('APP_RESILIENCE__PRESETS__INVENTORY__RETRY__BACKOFF__INITIAL_DELAY', '200ms')
    const registry = await registryFrom(new EnvConfigSource({ prefix: 'APP_' }), r =>
      r.preset('inventory', p => p.retry({ clock: fakeTimersClock })),
    )

    // 200ms then 400ms, each at the low end of a band half its width either way.
    expect(await delaysOf(registry)).toEqual([100, 200])
  })

  it('waits exactly the delay of a fixed backoff', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const registry = await registryFrom(
      new InlineConfigSource({
        resilience: { presets: { inventory: { retry: { backoff: { type: 'fixed', delay: '1s' } } } } },
      }),
      r => r.preset('inventory', p => p.retry({ clock: fakeTimersClock })),
    )

    expect(await delaysOf(registry)).toEqual([1_000, 1_000])
  })

  // A bare duration once meant a fixed wait; refusing it fails the deployment instead of changing what it waits.
  it('refuses a backoff written as a bare duration', async () => {
    vi.stubEnv('APP_RESILIENCE__PRESETS__INVENTORY__RETRY__BACKOFF', '200ms')

    await expect(registryFrom(new EnvConfigSource({ prefix: 'APP_' }))).rejects.toBeInstanceOf(ErrConfigValidation)
  })
})
