import { newConfiguration } from '@caffeinejs/application'
import { ErrConfigValidation, type InferConfig } from '@caffeinejs/application/config'
import { EnvConfigSource } from '@caffeinejs/application/config/env'
import { $t } from '@caffeinejs/application/schema'
import { CaffeineIoC, Injectable, Profile, token } from '@caffeinejs/di'
import { Controller, Get, Put } from '@caffeinejs/http'
import { ErrInvalidOption } from '@caffeinejs/resilience'
import {
  CircuitBreaker,
  Resilience,
  type ResilienceBuilder,
  ResilienceRegistry,
  Retry,
  TimeLimiter,
} from '@caffeinejs/resilience/aop'
import { ResilienceErrorHandler, ResilienceHTTP } from '@caffeinejs/resilience/http'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { startApp, type RunningApp } from './internal/app.js'
import { startUpstream, type Upstream } from './internal/upstream.js'

/**
 * Operators tune resilience from the environment, by instance name, without a code change: attempts, deadlines, a
 * breaker defined by configuration alone, and the HTTP methods a handler may retry. A bad value fails the start-up,
 * not a request.
 */

// The application declares the block it reads, as it declares the rest of its configuration.
const schema = $t.Object({
  resilience: $t.Object(
    {
      retries: $t.Optional(
        $t.Record(
          $t.String(),
          $t.Object({ maxAttempts: $t.Optional($t.Integer()), backoff: $t.Optional($t.Duration()) }),
        ),
      ),
      timeLimiters: $t.Optional($t.Record($t.String(), $t.Object({ timeoutDuration: $t.Optional($t.Duration()) }))),
      circuitBreakers: $t.Optional(
        $t.Record($t.String(), $t.Object({ minimumNumberOfCalls: $t.Optional($t.Integer()) })),
      ),
    },
    { default: {} },
  ),
  resilienceHttp: $t.Object({ retryableMethods: $t.Optional($t.List($t.String())) }, { default: {} }),
})

type Config = InferConfig<typeof schema>

const kInventory = token<string>('inventory origin')

@Injectable([kInventory])
@Profile('e2e-resilience-config', 'e2e-resilience-config-put', 'e2e-resilience-config-typo')
class InventoryClient {
  constructor(private readonly origin: string) {}

  @Retry('inventory')
  @TimeLimiter('inventory')
  async stock(id: string, signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${this.origin}/stock/${id}`, { signal })
    if (!res.ok) {
      throw new Error(`inventory answered ${res.status}`)
    }
    return id
  }
}

@Injectable([kInventory])
@Profile('e2e-resilience-config-reports')
class ReportsClient {
  constructor(private readonly origin: string) {}

  // Named only in configuration: without the variable, the application refuses to start.
  @CircuitBreaker('reports')
  async report(): Promise<string> {
    const res = await fetch(`${this.origin}/report`)
    if (!res.ok) {
      throw new Error(`reports answered ${res.status}`)
    }
    return 'report'
  }
}

@Controller('/report', [ReportsClient])
@Profile('e2e-resilience-config-reports')
class ReportsController {
  constructor(private readonly reports: ReportsClient) {}

  @Get('/')
  async report(): Promise<string> {
    return this.reports.report()
  }
}
void ReportsController

@Controller('/', [InventoryClient])
@Profile('e2e-resilience-config', 'e2e-resilience-config-put', 'e2e-resilience-config-typo')
class ShopController {
  constructor(private readonly inventory: InventoryClient) {}

  @Get('/stock/:id', p => [p.param('id'), p.signal()])
  async stock(id: string, signal: AbortSignal): Promise<string> {
    return this.inventory.stock(id, signal)
  }
}
void ShopController

@Controller('/carts')
@Profile('e2e-resilience-config-put')
class CartsController {
  // PUT replaces the cart whole, so running it twice is safe once an operator says PUT may be retried.
  @Retry('inventory')
  @Put('/:id', p => [p.param('id')])
  async replace(id: string): Promise<string> {
    return id
  }
}
void CartsController

@Injectable()
@Profile('e2e-resilience-config-typo')
class Misnamed {
  @CircuitBreaker('inventroy')
  async call(): Promise<string> {
    return 'ok'
  }
}
void Misnamed

let upstream: Upstream
const opened: Array<() => Promise<unknown>> = []

beforeEach(async () => {
  upstream = await startUpstream({ status: 503 })
})

afterEach(async () => {
  for (const close of opened.splice(0)) {
    await close().catch(() => undefined)
  }
  await upstream.close()
  vi.unstubAllEnvs()
})

// What code defines when a test does not say otherwise; the environment tunes what it leaves open.
const inventory = (r: ResilienceBuilder<Config>): unknown =>
  r.retry('inventory', { backoff: 0 }).timeLimiter('inventory', { timeoutDuration: 5 * Second })

async function shop(
  profile = 'e2e-resilience-config',
  code: (r: ResilienceBuilder<Config>) => unknown = inventory,
): Promise<{ running: RunningApp<Config>; registry: ResilienceRegistry }> {
  const container = new CaffeineIoC({ profiles: [profile] })
  container.bind(kInventory, t => t.toValue(upstream.origin))
  const config = newConfiguration(schema)
    .source(new EnvConfigSource({ prefix: 'APP_' }))
    .build().config
  const running = await startApp<Config>(
    app =>
      app
        .install(
          Resilience<Config>((r, { config }) => {
            code(r.config(config.resilience))
          }),
        )
        .install(ResilienceHTTP<Config>((h, { config }) => h.config(config.resilienceHttp)))
        .errorHandling(e => e.globalHandlers(ResilienceErrorHandler)),
    { container, config },
  )
  opened.push(() => running.close())
  return { running, registry: container.get(ResilienceRegistry) }
}

describe('resilience tuned from the environment', { timeout: 30_000 }, () => {
  it('retries as many times as the environment says', async () => {
    vi.stubEnv('APP_RESILIENCE__RETRIES__INVENTORY__MAX_ATTEMPTS', '5')
    const { running } = await shop()

    expect((await fetch(`${running.origin}/stock/42`)).status).toBe(500)
    expect(upstream.arrivals).toHaveLength(5)
  })

  it('cuts a call at the deadline the environment sets for a time limiter code defines without one', async () => {
    vi.stubEnv('APP_RESILIENCE__TIME_LIMITERS__INVENTORY__TIMEOUT_DURATION', '150ms')
    vi.stubEnv('APP_RESILIENCE__RETRIES__INVENTORY__MAX_ATTEMPTS', '1')
    upstream.setDefault('hang')
    const { running, registry } = await shop('e2e-resilience-config', r =>
      r.retry('inventory', { backoff: 0 }).timeLimiter('inventory', {}),
    )
    const limit = new Promise<number>(resolve =>
      registry.timeLimiter('inventory').on('timeout', e => resolve(e.timeoutDuration)),
    )

    expect((await fetch(`${running.origin}/stock/42`)).status).toBe(504)
    expect(await limit).toBe(150)
    await upstream.abandoned(1)
  })

  // An author who pinned an option in code meant it: the environment tunes only what code left open.
  it('lets code win over the environment for the same option', async () => {
    vi.stubEnv('APP_RESILIENCE__RETRIES__INVENTORY__MAX_ATTEMPTS', '5')
    const { running } = await shop('e2e-resilience-config', r =>
      r.retry('inventory', { maxAttempts: 2, backoff: 0 }).timeLimiter('inventory', { timeoutDuration: 5 * Second }),
    )

    await fetch(`${running.origin}/stock/42`)

    expect(upstream.arrivals).toHaveLength(2)
  })

  it('refuses to start when a decorator names an instance only a missing variable would define', async () => {
    const error = await shop('e2e-resilience-config-reports').catch((reason: unknown) => reason as Error)

    expect((error as Error).message.split('\n')[0]).toBe(
      'Cannot weave "ReportsClient.report": no circuit breaker named "reports" is defined',
    )
  })

  it('serves a decorator from an instance the environment alone defines', async () => {
    vi.stubEnv('APP_RESILIENCE__CIRCUIT_BREAKERS__REPORTS__MINIMUM_NUMBER_OF_CALLS', '2')
    const { running, registry } = await shop('e2e-resilience-config-reports')

    await fetch(`${running.origin}/report`)
    await fetch(`${running.origin}/report`)
    const refused = await fetch(`${running.origin}/report`)

    expect(registry.circuitBreaker('reports').state).toBe('open')
    expect(refused.status).toBe(503)
    expect(upstream.arrivals).toHaveLength(2)
  })

  it('lets a PUT handler carry @Retry once the environment makes PUT retryable', async () => {
    vi.stubEnv('APP_RESILIENCE_HTTP__RETRYABLE_METHODS', 'GET,HEAD,OPTIONS,PUT')
    const { running } = await shop('e2e-resilience-config-put')

    expect((await fetch(`${running.origin}/carts/7`, { method: 'PUT' })).status).toBe(200)
  })

  it('refuses to start the same application when the environment leaves PUT out', async () => {
    const error = await shop('e2e-resilience-config-put').catch((reason: unknown) => reason as Error)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message).toContain(
      'Cannot retry "PUT /carts/:id" (CartsController.replace): PUT is not a retryable method',
    )
  })
})

describe('bad resilience settings fail the start-up', { timeout: 30_000 }, () => {
  it('names the method and the instance when a decorator names one nothing defines', async () => {
    const error = await shop('e2e-resilience-config-typo').catch((reason: unknown) => reason as Error)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message.split('\n')[0]).toBe(
      'Cannot weave "Misnamed.call": no circuit breaker named "inventroy" is defined',
    )
  })

  it('refuses a deadline of 0, which would mean no deadline at all', async () => {
    vi.stubEnv('APP_RESILIENCE__TIME_LIMITERS__REPORTS__TIMEOUT_DURATION', '0')

    const error = await shop().catch((reason: unknown) => reason as Error)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message.split('\n')[0]).toBe(
      'Cannot create time limiter "reports": timeoutDuration must be a finite Duration greater than 0s, got 0s',
    )
  })

  // Milliseconds or seconds? A duration without its unit is refused rather than guessed.
  it('refuses a duration written as a bare number', async () => {
    vi.stubEnv('APP_RESILIENCE__TIME_LIMITERS__REPORTS__TIMEOUT_DURATION', '150')

    await expect(shop()).rejects.toBeInstanceOf(ErrConfigValidation)
  })
})
