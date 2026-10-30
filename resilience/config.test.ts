import { createApplication, newConfiguration } from '@caffeinejs/application'
import { ErrConfigValidation, type ConfigSource } from '@caffeinejs/application/config'
import { EnvConfigSource } from '@caffeinejs/application/config/env'
import { InlineConfigSource } from '@caffeinejs/application/config/inline'
import { $t, type InferSchema } from '@caffeinejs/application/schema'
import { CaffeineIoC } from '@caffeinejs/di'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ResilienceConfigSchema } from './_spectypes/index.js'
import { Resilience } from './aop/feature.js'
import { ResilienceRegistry } from './aop/registry.js'
import { runWith } from './compose.js'
import { useFakeClock } from './fake_clock.testkit.js'
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

// Boots an application whose configuration comes from `source`, with the resilience block handed to the feature.
async function registryFrom(source: ConfigSource): Promise<ResilienceRegistry> {
  const config = newConfiguration(appConfigSchema).source(source).build().config
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }), config }).install(
    Resilience<AppConfig>((r, { config }) => r.config(config.resilience)),
  )
  opened.push(() => app.close())
  await app.bootstrap()
  return app.container.get(ResilienceRegistry)
}

describe('resilience configuration', () => {
  // Configuration writes durations as text: the instance must run on what the text says, in milliseconds.
  it('decodes a duration written as text into the instance it defines', async () => {
    useFakeClock({ toFake: ['performance'] })
    const registry = await registryFrom(
      new InlineConfigSource({
        resilience: { rateLimiters: { partner: { limitForPeriod: 1, limitRefreshPeriod: '1500ms' } } },
      }),
    )
    const quota = registry.rateLimiter('partner')

    await runWith(() => 'ok', quota)
    const refused = await runWith(() => 'ok', quota).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(ErrRateLimitExceeded)
    expect((refused as ErrRateLimitExceeded).retryAfter).toBe(1_500)
  })

  // A bare number has no unit: is 150 milliseconds or seconds? The deployment fails rather than guess.
  it('refuses a duration written as a bare number at bootstrap', async () => {
    const error = await registryFrom(
      new InlineConfigSource({ resilience: { timeLimiters: { inventory: { timeoutDuration: '150' } } } }),
    ).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrConfigValidation)
  })

  it('refuses an option out of range at bootstrap', async () => {
    const error = await registryFrom(
      new InlineConfigSource({ resilience: { bulkheads: { exports: { maxConcurrentCalls: 0 } } } }),
    ).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrConfigValidation)
  })

  // An operator defines or retunes an instance with an environment variable alone, by name.
  it('defines an instance from an environment variable, its name a key of the record', async () => {
    vi.stubEnv('APP_RESILIENCE__RETRIES__INVENTORY__MAX_ATTEMPTS', '5')
    vi.stubEnv('APP_RESILIENCE__RETRIES__INVENTORY__BACKOFF', '0')
    const registry = await registryFrom(new EnvConfigSource({ prefix: 'APP_' }))
    let attempts = 0

    await runWith(() => {
      attempts++
      throw new Error('down')
    }, registry.retry('inventory')).catch(() => undefined)

    expect(attempts).toBe(5)
  })
})
