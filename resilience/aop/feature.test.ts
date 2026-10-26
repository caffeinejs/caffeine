import { createApplication, ErrFeatureAlreadyInstalled, type Feature } from '@caffeinejs/application'
import { CaffeineIoC } from '@caffeinejs/di'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { ErrCallNotPermitted } from '../circuitbreaker/circuitbreaker.js'
import { runWith } from '../compose.js'
import { ErrInvalidOption } from '../errors.js'
import { ErrMaxRetriesExceeded } from '../retry/retry.js'
import { CircuitBreaker, Fallback, Retry } from './annotations.js'
import { Resilience, type ResilienceBuilder } from './feature.js'
import { ResilienceRegistry } from './registry.js'

const opened: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const close of opened.splice(0)) {
    await close()
  }
})

class Inventory {
  attempts = 0

  @Retry('inventory')
  @CircuitBreaker('inventory')
  async stock(): Promise<string> {
    this.attempts++
    throw new Error('down')
  }
}

// Boots an application with decorators off, the feature installed and the classes bound by hand.
async function boot(feature: Feature, ...classes: Array<new () => object>) {
  const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(feature)
  app.container.bind(Inventory, t => t.toSelf())
  for (const cls of classes) {
    app.container.bind(cls, t => t.toSelf())
  }
  opened.push(() => app.close())
  await app.bootstrap()
  return app
}

const inventory = (r: ResilienceBuilder) =>
  r
    .retry('inventory', { maxAttempts: 3, backoff: 0 })
    .circuitBreaker('inventory', { minimumNumberOfCalls: 2, slidingWindow: { type: 'count', size: 2 } })

describe('Resilience()', () => {
  it('binds the registry it builds, holding the instances code defined', async () => {
    const app = await boot(Resilience(inventory))
    const registry = app.container.get(ResilienceRegistry)

    expect(registry.retry('inventory').name).toBe('inventory')
    expect(registry.circuitBreaker('inventory').name).toBe('inventory')
  })

  it('weaves the instances into the annotated methods of the classes the container builds', async () => {
    const app = await boot(Resilience(inventory))
    const target = app.container.get(Inventory)

    await expect(target.stock()).rejects.toBeInstanceOf(ErrCallNotPermitted)
    expect(target.attempts).toBe(2)
  })

  // Configuration tunes what code left open; what code set is the last word.
  it('merges configuration and code per option, code winning', async () => {
    const app = await boot(
      Resilience(r =>
        inventory(r)
          .config({ retries: { polling: { maxAttempts: 5, failAfterMaxAttempts: true, backoff: 0 } } })
          .retry('polling', { maxAttempts: 3, retryOnResult: result => result === 'busy' }),
      ),
    )
    let attempts = 0

    const error = await runWith(() => {
      attempts++
      return 'busy'
    }, app.container.get(ResilienceRegistry).retry('polling')).catch((reason: unknown) => reason)

    // maxAttempts from code, failAfterMaxAttempts from configuration.
    expect(attempts).toBe(3)
    expect(error).toBeInstanceOf(ErrMaxRetriesExceeded)
  })

  it('defines an instance named only in configuration', async () => {
    const app = await boot(Resilience(r => inventory(r).config({ bulkheads: { exports: { maxConcurrentCalls: 3 } } })))

    expect(app.container.get(ResilienceRegistry).bulkhead('exports').metrics().maxAllowedConcurrentCalls).toBe(3)
  })

  // Two test applications must never share a breaker: one opened by a test leaks into every test after it otherwise.
  it('gives each application a registry of its own', async () => {
    const first = await boot(Resilience(inventory))
    const second = await boot(Resilience(inventory))

    await first.container
      .get(Inventory)
      .stock()
      .catch(() => undefined)

    expect(first.container.get(ResilienceRegistry).circuitBreaker('inventory').state).toBe('open')
    expect(second.container.get(ResilienceRegistry).circuitBreaker('inventory').state).toBe('closed')
  })

  it('refuses to be installed twice', () => {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(Resilience())

    expect(() => app.install(Resilience())).toThrow(ErrFeatureAlreadyInstalled)
  })
})

describe('Resilience() at bootstrap', () => {
  class Misnamed {
    @CircuitBreaker('inventroy')
    async call(): Promise<string> {
      return 'ok'
    }
  }

  class MissingFallback {
    // @ts-expect-error -- the method does not exist; this is the start-up check's case
    @Fallback('cachedStok')
    async call(): Promise<string> {
      return 'ok'
    }
  }

  // A typo in a name must fail the deployment, not the first call that reaches the method in production.
  it('fails when a method names an instance nothing defines', async () => {
    const error = await boot(Resilience(inventory), Misnamed).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message).toContain(
      'Cannot weave "Misnamed.call": no circuit breaker named "inventroy" is defined',
    )
    expect((error as Error).message).toContain("Define it with Resilience(r => r.circuitBreaker('inventroy', { ... }))")
  })

  it('fails when a @Fallback names a method its class lacks', async () => {
    const error = await boot(Resilience(inventory), MissingFallback).catch((reason: unknown) => reason)

    expect((error as Error).message).toContain(
      'Cannot weave "MissingFallback.call": @Fallback names "cachedStok", which is not a method of "MissingFallback"',
    )
  })

  it('fails on an option out of range, whether code or configuration set it', async () => {
    const fromCode = await boot(Resilience(r => inventory(r).timeLimiter('reports', { timeoutDuration: 0 }))).catch(
      (reason: unknown) => reason,
    )
    const fromConfig = await boot(
      Resilience(r => inventory(r).config({ timeLimiters: { reports: { timeoutDuration: 0 } } })),
    ).catch((reason: unknown) => reason)

    for (const error of [fromCode, fromConfig]) {
      expect(error).toBeInstanceOf(ErrInvalidOption)
      expect((error as Error).message).toContain(
        'Cannot create time limiter "reports": timeoutDuration must be a finite Duration greater than 0s, got 0s',
      )
    }
  })
})
