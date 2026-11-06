import { createApplication, ErrFeatureAlreadyInstalled, type Feature } from '@caffeinejs/application'
import { CaffeineIoC } from '@caffeinejs/di'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { run } from '../compose.js'
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
  r.preset('inventory', p =>
    p
      .retry({ maxAttempts: 3, backoff: 0 })
      .circuitBreaker({ minimumNumberOfCalls: 2, slidingWindow: { type: 'count', size: 2 } }),
  )

describe('Resilience()', () => {
  it('binds the registry it builds, holding the policies of each preset code defined', async () => {
    const app = await boot(Resilience(inventory))
    const registry = app.container.get(ResilienceRegistry)

    expect(registry.retry('inventory').name).toBe('inventory')
    expect(registry.circuitBreaker('inventory').name).toBe('inventory')
  })

  it('weaves the instances into the annotated methods of the classes the container builds', async () => {
    const app = await boot(Resilience(inventory))
    const target = app.container.get(Inventory)

    await expect(target.stock()).rejects.toThrow('down')
    expect(target.attempts).toBe(2)
    expect(app.container.get(ResilienceRegistry).circuitBreaker('inventory').state).toBe('open')
  })

  // Configuration tunes what code left open; what code set is the last word.
  it('merges configuration and code per option, code winning', async () => {
    const app = await boot(
      Resilience(r =>
        inventory(r)
          .config({
            presets: {
              polling: { retry: { maxAttempts: 5, failAfterMaxAttempts: true, backoff: { type: 'fixed', delay: 0 } } },
            },
          })
          .preset('polling', p => p.retry({ maxAttempts: 3, retryOnResult: result => result === 'busy' })),
      ),
    )
    let attempts = 0

    const error = await run(
      app.container
        .get(ResilienceRegistry)
        .retry('polling')
        .wrap(async () => {
          attempts++
          return 'busy'
        }),
    ).catch((reason: unknown) => reason)

    // maxAttempts from code, failAfterMaxAttempts from configuration.
    expect(attempts).toBe(3)
    expect(error).toBeInstanceOf(ErrMaxRetriesExceeded)
  })

  // `{ maxAttempts: flag ? 5 : undefined }` in code means "code does not say", not "erase what configuration says".
  it('keeps a configured option that code passes as undefined', async () => {
    const app = await boot(
      Resilience(r =>
        inventory(r)
          .config({ presets: { polling: { retry: { maxAttempts: 4 } } } })
          .preset('polling', p => p.retry({ maxAttempts: undefined, backoff: 0 })),
      ),
    )
    let attempts = 0

    await run(
      app.container
        .get(ResilienceRegistry)
        .retry('polling')
        .wrap(async () => {
          attempts++
          throw new Error('down')
        }),
    ).catch(() => undefined)

    expect(attempts).toBe(4)
  })

  // Two definitions of one name in code are a mistake to report, not a choice to make silently.
  it('refuses a preset defined twice in code', async () => {
    const error = await boot(
      Resilience(r =>
        inventory(r)
          .preset('polling', p => p.retry())
          .preset('polling', p => p.circuitBreaker()),
      ),
    ).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message.split('\n')[0]).toBe('Cannot define preset "polling" twice')
  })

  it('refuses a policy defined twice in one preset', async () => {
    const error = await boot(
      Resilience(r => r.preset('polling', p => p.retry({ maxAttempts: 2 }).retry({ maxAttempts: 5 }))),
    ).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message.split('\n')[0]).toBe('Cannot define the retry of preset "polling" twice')
  })

  // A preset with nothing in it would weave a method into nothing, silently.
  it('refuses a preset that defines no policy, in code or in configuration', async () => {
    const fromCode = await boot(Resilience(r => inventory(r).preset('empty', p => p))).catch(
      (reason: unknown) => reason,
    )
    const fromConfig = await boot(Resilience(r => inventory(r).config({ presets: { empty: {} } }))).catch(
      (reason: unknown) => reason,
    )

    for (const error of [fromCode, fromConfig]) {
      expect(error).toBeInstanceOf(ErrInvalidOption)
      expect((error as Error).message.split('\n')[0]).toBe('Cannot define preset "empty": it defines no policy')
    }
  })

  // A function cannot be merged with fields: the backoff code sets replaces the configured one whole.
  it('lets a backoff code sets replace the configured one whole', async () => {
    const app = await boot(
      Resilience(r =>
        inventory(r)
          .config({ presets: { polling: { retry: { backoff: { type: 'fixed', delay: 30 * Second } } } } })
          .preset('polling', p => p.retry({ backoff: attempt => attempt * 10 })),
      ),
    )
    const retry = app.container.get(ResilienceRegistry).retry('polling')
    const delays: number[] = []
    retry.on('retry', e => delays.push(e.delay))

    await run(
      retry.wrap(async () => {
        throw new Error('down')
      }),
    ).catch(() => undefined)

    expect(delays).toEqual([10, 20])
  })

  // Configuration read without the schema, or written by hand, can still hold yesterday's bare duration.
  it('refuses a configured backoff that is not a fixed or an exponential one', async () => {
    const error = await boot(
      Resilience(r => inventory(r).config({ presets: { polling: { retry: { backoff: 200 as never } } } })),
    ).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message.split('\n')[0]).toBe(
      'Cannot define the retry of preset "polling": the configured backoff must be an object of type "fixed" or "exponential", got a number',
    )
  })

  it('defines a preset named only in configuration', async () => {
    const app = await boot(
      Resilience(r => inventory(r).config({ presets: { exports: { bulkhead: { maxConcurrentCalls: 3 } } } })),
    )

    expect(app.container.get(ResilienceRegistry).bulkhead('exports').metrics().maxAllowedConcurrentCalls).toBe(3)
  })

  // An operator can add a policy to a preset without a code change, as they can tune one.
  it('adds a policy that configuration defines and code left out', async () => {
    const app = await boot(
      Resilience(r => inventory(r).config({ presets: { inventory: { bulkhead: { maxConcurrentCalls: 3 } } } })),
    )
    const registry = app.container.get(ResilienceRegistry)

    expect(registry.has('inventory', 'retry')).toBe(true)
    expect(registry.bulkhead('inventory').metrics().maxAllowedConcurrentCalls).toBe(3)
  })

  // The run order is the application's; the order a preset's policies are written in says nothing about it.
  it('runs the policies of a preset in the fixed order, whatever order the builder calls are in', async () => {
    const app = await boot(
      Resilience(r =>
        r.preset('inventory', p =>
          p
            .circuitBreaker({ minimumNumberOfCalls: 2, slidingWindow: { type: 'count', size: 2 } })
            .retry({ maxAttempts: 3, backoff: 0 }),
        ),
      ),
    )
    const target = app.container.get(Inventory)

    await target.stock().catch(() => undefined)

    // Retry outside the breaker: two failures open it, and the third attempt is refused without running.
    expect(target.attempts).toBe(2)
    expect(app.container.get(ResilienceRegistry).circuitBreaker('inventory').metrics().failedCalls).toBe(2)
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

  // The usual reason to reorder: one logical call, with every retry it took, counts once in the breaker.
  it('orders the policies as code says, over configuration', async () => {
    const breakerFirst = ['circuitBreaker', 'retry', 'rateLimiter', 'timeLimiter', 'bulkhead'] as const
    const retryFirst = ['retry', 'circuitBreaker', 'rateLimiter', 'timeLimiter', 'bulkhead'] as const
    const fromConfig = await boot(Resilience(r => inventory(r).config({ order: breakerFirst })))
    const fromCode = await boot(Resilience(r => inventory(r).config({ order: retryFirst }).order(breakerFirst)))

    for (const app of [fromConfig, fromCode]) {
      const target = app.container.get(Inventory)
      await target.stock().catch(() => undefined)

      expect(target.attempts).toBe(3)
      expect(app.container.get(ResilienceRegistry).circuitBreaker('inventory').metrics().failedCalls).toBe(1)
    }
  })

  // A retry sleeping out a long backoff would otherwise hold a deploy's shutdown until it woke.
  it('disposes its instances when the application closes, so a sleeping retry ends at once', async () => {
    const app = await boot(
      Resilience(r => r.preset('inventory', p => p.retry({ maxAttempts: 3, backoff: 30 * Second }).circuitBreaker())),
    )
    const target = app.container.get(Inventory)
    const call = target.stock().catch((reason: unknown) => reason)

    await app.close()

    expect(await call).toMatchObject({ message: 'down' })
    expect(target.attempts).toBe(1)
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
  it('fails when a method names a preset nothing defines', async () => {
    const error = await boot(Resilience(inventory), Misnamed).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message).toContain('Cannot weave "Misnamed.call": no preset named "inventroy" is defined')
    expect((error as Error).message).toContain("Define it with Resilience(r => r.preset('inventroy', p => ...))")
  })

  it('fails when a @Fallback names a method its class lacks', async () => {
    const error = await boot(Resilience(inventory), MissingFallback).catch((reason: unknown) => reason)

    expect((error as Error).message).toContain(
      'Cannot weave "MissingFallback.call": @Fallback names "cachedStok", which is not a method of "MissingFallback"',
    )
  })

  it('fails on an order that does not list each kind once, whether code or configuration set it', async () => {
    const fromCode = await boot(Resilience(r => inventory(r).order(['retry', 'circuitBreaker']))).catch(
      (reason: unknown) => reason,
    )
    const fromConfig = await boot(Resilience(r => inventory(r).config({ order: ['retry', 'retry'] }))).catch(
      (reason: unknown) => reason,
    )

    expect(fromCode).toBeInstanceOf(ErrInvalidOption)
    expect((fromCode as Error).message).toContain(
      'Cannot order the resilience policies: order leaves out "rateLimiter"',
    )
    expect((fromConfig as Error).message).toContain('Cannot order the resilience policies: order names "retry" twice')
  })

  it('fails on an option out of range, whether code or configuration set it', async () => {
    const fromCode = await boot(
      Resilience(r => inventory(r).preset('reports', p => p.timeLimiter({ timeoutDuration: 0 }))),
    ).catch((reason: unknown) => reason)
    const fromConfig = await boot(
      Resilience(r => inventory(r).config({ presets: { reports: { timeLimiter: { timeoutDuration: 0 } } } })),
    ).catch((reason: unknown) => reason)

    for (const error of [fromCode, fromConfig]) {
      expect(error).toBeInstanceOf(ErrInvalidOption)
      expect((error as Error).message).toContain(
        'Cannot create time limiter "reports": timeoutDuration must be a finite Duration greater than 0s, got 0s',
      )
    }
  })
})
