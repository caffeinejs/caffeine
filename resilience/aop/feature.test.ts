import { createApplication, ErrFeatureAlreadyInstalled, type Feature } from '@caffeinejs/application'
import { CaffeineIoC } from '@caffeinejs/di'
import { Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it } from 'vitest'

import { run } from '../compose.js'
import { ErrInvalidOption } from '../errors.js'
import { ErrMaxRetriesExceeded } from '../retry/retry.js'
import { Bulkhead, CircuitBreaker, Fallback, RateLimiter, Resilient, Retry, TimeLimiter } from './annotations.js'
import { Resilience, type ResilienceBuilder } from './feature.js'
import { ResilienceRegistry } from './registry.js'
import { kEntrypoint, ResilienceTransport } from './transport.js'

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

  // Each layer is more specific than the one before: a value written for one preset beats one written for all.
  it('takes an option from the most specific of defaults and preset, configured and coded', async () => {
    const attemptsOf = async (config: object, code: (r: ResilienceBuilder) => ResilienceBuilder) => {
      const app = await boot(Resilience(r => code(inventory(r).config(config))))
      let attempts = 0
      await run(
        app.container
          .get(ResilienceRegistry)
          .retry('ledger')
          .wrap(async () => {
            attempts++
            throw new Error('down')
          }),
      ).catch(() => undefined)
      return attempts
    }
    const ledger = (maxAttempts?: number) => (r: ResilienceBuilder) =>
      r.preset('ledger', p => p.retry({ maxAttempts, backoff: 0 }))
    const defaults =
      (maxAttempts: number, then: (r: ResilienceBuilder) => ResilienceBuilder) => (r: ResilienceBuilder) =>
        then(r.defaults(p => p.retry({ maxAttempts })))

    expect(await attemptsOf({}, ledger())).toBe(3)
    expect(await attemptsOf({ defaults: { retry: { maxAttempts: 4 } } }, ledger())).toBe(4)
    expect(await attemptsOf({ defaults: { retry: { maxAttempts: 4 } } }, defaults(2, ledger()))).toBe(2)
    expect(
      await attemptsOf(
        { defaults: { retry: { maxAttempts: 4 } }, presets: { ledger: { retry: { maxAttempts: 6 } } } },
        defaults(2, ledger()),
      ),
    ).toBe(6)
    expect(
      await attemptsOf(
        { defaults: { retry: { maxAttempts: 4 } }, presets: { ledger: { retry: { maxAttempts: 6 } } } },
        defaults(2, ledger(5)),
      ),
    ).toBe(5)
  })

  // Defaults shape the policies a preset has; which policies it has stays the preset's decision.
  it('adds no policy to a preset from the defaults', async () => {
    const app = await boot(
      Resilience(r =>
        inventory(r)
          .config({ defaults: { bulkhead: { maxConcurrentCalls: 3 } } })
          .defaults(p => p.timeLimiter({ timeoutDuration: 1 * Second }))
          .preset('ledger', p => p.retry()),
      ),
    )
    const registry = app.container.get(ResilienceRegistry)

    expect(registry.has('ledger', 'retry')).toBe(true)
    expect(registry.has('ledger', 'timeLimiter')).toBe(false)
    expect(registry.has('ledger', 'bulkhead')).toBe(false)
  })

  it('refuses the defaults defined twice', async () => {
    const error = await boot(
      Resilience(r =>
        inventory(r)
          .defaults(p => p.retry())
          .defaults(p => p.bulkhead()),
      ),
    ).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message.split('\n')[0]).toBe('Cannot define the defaults twice')
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

describe('Resilience() and transports', () => {
  const kService = Symbol('grpc service')

  class StockService {
    @Retry('inventory')
    async get(): Promise<string> {
      return 'stock'
    }
  }

  class GRPCTransport extends ResilienceTransport {
    readonly label = kService

    isClientError(): boolean {
      return false
    }
  }

  // A breaker on an entrypoint: unless its transport tells them apart, a client's own errors count as failures.
  class Shelf {
    @CircuitBreaker('shelf')
    async count(): Promise<number> {
      return 3
    }
  }

  // A fallback on an entrypoint: unless its transport tells them apart, it answers a client's own errors too.
  class Orders {
    @Fallback('cached')
    async find(): Promise<string> {
      return 'order'
    }

    async cached(_error: unknown): Promise<string> {
      return 'cached order'
    }
  }

  // A breaker that no stage annotation names: the class's @Resilient reaches it through its preset.
  @Resilient('shelf')
  class Pantry {
    async count(): Promise<number> {
      return 3
    }
  }

  // Policies that never look at an error, so a client's own error means nothing to them.
  class Ledger {
    @TimeLimiter('local')
    @Bulkhead('local')
    @RateLimiter('local')
    async total(): Promise<number> {
      return 7
    }
  }

  // Entrypoints of a transport this package has never heard of: each method runs on a request.
  async function serve(transport: boolean, ...entrypoints: (new () => object)[]) {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(
      Resilience(r =>
        inventory(r)
          .preset('shelf', p => p.circuitBreaker())
          .preset('local', p =>
            p
              .timeLimiter({ timeoutDuration: 1 * Second })
              .bulkhead()
              .rateLimiter({ limitForPeriod: 100, limitRefreshPeriod: 1 * Second }),
          ),
      ),
    )
    for (const entrypoint of entrypoints) {
      app.container.bind(entrypoint, t => t.toSelf().labels(kService, kEntrypoint))
    }
    if (transport) {
      app.container.bind(GRPCTransport, t => t.toSelf().extends(ResilienceTransport))
    }
    opened.push(() => app.close())
    await app.bootstrap()
    return app
  }

  it('refuses a retried entrypoint that no installed transport integration claims', async () => {
    const error = await serve(false, StockService).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message.split('\n')[0]).toBe(
      'Cannot retry "StockService.get": @Retry(\'inventory\') retries a request entrypoint that no installed transport integration checks',
    )
  })

  // A controller bound by hand carries the label the HTTP package reads, and may lack the neutral one: a retry on it
  // replays requests all the same.
  it('refuses a retried controller bound with only the HTTP controller label', async () => {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(Resilience(inventory))
    app.container.bind(StockService, t => t.toSelf().labels(Symbol.for('@caffeinejs/http:controller')))
    opened.push(() => app.close())

    const error = await app.bootstrap().catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message.split('\n')[0]).toBe(
      'Cannot retry "StockService.get": @Retry(\'inventory\') retries a request entrypoint that no installed transport integration checks',
    )
  })

  it('leaves a retried entrypoint to the transport that claims its label', async () => {
    const app = await serve(true, StockService)

    await expect(app.container.get(StockService).get()).resolves.toBe('stock')
  })

  // Unclassified, a burst of requests for missing records would open the breaker for every client.
  it('refuses a circuit breaker on an entrypoint that no installed transport integration claims', async () => {
    const error = await serve(false, Shelf).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    const message = (error as Error).message
    expect(message.split('\n')[0]).toBe(
      "Cannot weave \"Shelf.count\": no installed transport integration claims this request entrypoint, so @CircuitBreaker('shelf') would count a client's own error, such as a 404 it throws, as a failure",
    )
    expect(message).toContain(
      'Install ResilienceHTTP() from @caffeinejs/resilience/http with .install(ResilienceHTTP()) if "Shelf" is an HTTP controller',
    )
    expect(message).toContain(
      'Install the resilience integration of the transport that serves "Shelf" if it is not an HTTP controller',
    )
    expect(message).toContain('Move @CircuitBreaker(\'shelf\') to the outbound client method that "Shelf.count" calls')
  })

  // Unclassified, a fallback would answer the 403 a method throws to refuse a caller, with what it refused.
  it('refuses a fallback on an entrypoint that no installed transport integration claims', async () => {
    const error = await serve(false, Orders).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    const message = (error as Error).message
    expect(message.split('\n')[0]).toBe(
      "Cannot weave \"Orders.find\": no installed transport integration claims this request entrypoint, so @Fallback('cached') would answer a client's own error, such as a 403 it throws",
    )
    expect(message).toContain(
      'Install ResilienceHTTP() from @caffeinejs/resilience/http with .install(ResilienceHTTP()) if "Orders" is an HTTP controller',
    )
    expect(message).toContain(
      'Install the resilience integration of the transport that serves "Orders" if it is not an HTTP controller',
    )
  })

  it('refuses a breaker that the class-level @Resilient names through its preset', async () => {
    const error = await serve(false, Pantry).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrInvalidOption)
    expect((error as Error).message.split('\n')[0]).toBe(
      "Cannot weave \"Pantry.count\": no installed transport integration claims this request entrypoint, so @Resilient('shelf') would count a client's own error, such as a 404 it throws, as a failure",
    )
  })

  it('leaves a breaker and a fallback on an entrypoint to the transport that claims its label', async () => {
    const app = await serve(true, Shelf, Orders)

    await expect(app.container.get(Shelf).count()).resolves.toBe(3)
    await expect(app.container.get(Orders).find()).resolves.toBe('order')
  })

  // A time limiter, a bulkhead and a rate limiter treat every error alike, so they need no transport to classify one.
  it('starts an entrypoint no transport claims when none of its policies judges an error', async () => {
    const app = await serve(false, Ledger)

    await expect(app.container.get(Ledger).total()).resolves.toBe(7)
  })
})

describe('Resilience() and the client errors of a transport', () => {
  const kService = Symbol('grpc service')

  class ErrNotFound extends Error {}

  class GRPCTransport extends ResilienceTransport {
    readonly label = kService

    isClientError(error: unknown): boolean {
      return error instanceof ErrNotFound
    }
  }

  // Outbound: the dependency's own 404 is its failure, which this class's policies must still see.
  class Catalog {
    attempts = 0

    @Retry('inventory')
    @CircuitBreaker('inventory')
    async lookup(): Promise<string> {
      this.attempts++
      throw new ErrNotFound('the dependency lost the record')
    }
  }

  // Inbound: an entrypoint of the transport, naming the same preset as the client it calls.
  class Storefront {
    attempts = 0

    @Retry('inventory')
    @CircuitBreaker('inventory')
    async item(catalog: Catalog, id: string): Promise<string> {
      this.attempts++
      if (id === 'missing') {
        throw new ErrNotFound('no such item')
      }
      return catalog.lookup()
    }
  }

  async function serve() {
    const app = createApplication({ container: new CaffeineIoC({ decorators: false }) }).install(
      Resilience(r =>
        r.preset('inventory', p =>
          p
            .retry({ maxAttempts: 3, backoff: 0 })
            .circuitBreaker({ minimumNumberOfCalls: 10, slidingWindow: { type: 'count', size: 10 } }),
        ),
      ),
    )
    app.container.bind(Storefront, t => t.toSelf().labels(kService, kEntrypoint))
    app.container.bind(Catalog, t => t.toSelf())
    app.container.bind(GRPCTransport, t => t.toSelf().extends(ResilienceTransport))
    opened.push(() => app.close())
    await app.bootstrap()
    return app
  }

  // One client asking for what does not exist must neither multiply the work nor count against the dependency.
  it('runs an entrypoint once on an error its transport calls a client error, and leaves the breaker untouched', async () => {
    const app = await serve()
    const storefront = app.container.get(Storefront)
    const breaker = app.container.get(ResilienceRegistry).circuitBreaker('inventory')

    const error = await storefront.item(app.container.get(Catalog), 'missing').catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrNotFound)
    expect(storefront.attempts).toBe(1)
    expect(breaker.metrics().bufferedCalls).toBe(0)
  })

  // The classification belongs to the entrypoint's own calls: a client class it calls keeps its policies whole.
  it('still retries and counts the same error in a class the entrypoint calls', async () => {
    const app = await serve()
    const storefront = app.container.get(Storefront)
    const catalog = app.container.get(Catalog)
    const breaker = app.container.get(ResilienceRegistry).circuitBreaker('inventory')

    const error = await storefront.item(catalog, 'tea').catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(ErrNotFound)
    expect(catalog.attempts).toBe(3)
    expect(storefront.attempts).toBe(1)
    expect(breaker.metrics()).toMatchObject({ bufferedCalls: 3, failedCalls: 3 })
  })
})
