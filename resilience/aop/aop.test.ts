import { AsyncLocalStorage } from 'node:async_hooks'

import {
  $aop,
  CaffeineIoC,
  contextKey,
  type ContextStorage,
  ExecutionContext,
  Injectable,
  type JoinPoint,
  type MethodAspect,
  Profile,
  Scopes,
  token,
} from '@caffeinejs/di'
import { Hour, Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrBulkheadFull } from '../bulkhead/bulkhead.js'
import { ErrCallNotPermitted } from '../circuitbreaker/circuitbreaker.js'
import { fakeTimersClock } from '../clock.testkit.js'
import { ErrInvalidOption } from '../errors.js'
import { ErrRateLimitExceeded } from '../ratelimiter/ratelimiter.js'
import { ErrTimeLimitExceeded } from '../timelimiter/timelimiter.js'
import type { Clock } from '../timers.js'
import { Bulkhead, CircuitBreaker, Fallback, RateLimiter, Resilient, Retry, TimeLimiter } from './annotations.js'
import { RESILIENCE_ASPECT_ORDER, ResilienceAspect, resiliencePointcut } from './aop.js'
import { type ResilienceDefinitions, type ResilienceKind, ResilienceRegistry } from './registry.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const DEFINITIONS: ResilienceDefinitions = {
  inventory: {
    retry: { maxAttempts: 3, backoff: 0 },
    circuitBreaker: { minimumNumberOfCalls: 2, slidingWindow: { type: 'count', size: 2 } },
    timeLimiter: { timeoutDuration: 100 * Millisecond },
    bulkhead: { maxConcurrentCalls: 1 },
    rateLimiter: { limitForPeriod: 1, limitRefreshPeriod: 1 * Hour },
  },
  shared: { circuitBreaker: { minimumNumberOfCalls: 2, slidingWindow: { type: 'count', size: 2 } } },
}

// The definitions with every instance on the clock the test drives, unless a definition gives its own.
function onFakeClock(definitions: ResilienceDefinitions): ResilienceDefinitions {
  return Object.fromEntries(
    Object.entries(definitions).map(([name, preset]) => [
      name,
      Object.fromEntries(Object.entries(preset).map(([kind, o]) => [kind, { clock: fakeTimersClock, ...o }])),
    ]),
  )
}

// A container with the aspect and a registry bound by hand, decorators off, so no fixture registers anywhere else.
async function containerWith(
  bind: (di: CaffeineIoC) => void,
  definitions: ResilienceDefinitions = DEFINITIONS,
  options: { profiles?: string[]; order?: readonly ResilienceKind[]; storage?: ContextStorage } = {},
) {
  const di = new CaffeineIoC(options.profiles === undefined ? { decorators: false } : { profiles: options.profiles })
  const registry = new ResilienceRegistry(onFakeClock(definitions))
  di.bind(ResilienceRegistry, t => t.toValue(registry))
  di.aspect(ResilienceAspect, s =>
    s
      .toValue(new ResilienceAspect(registry, options.order, options.storage))
      .pointcuts(resiliencePointcut)
      .order(RESILIENCE_ASPECT_ORDER),
  )
  bind(di)
  await di.init()
  return { di, registry }
}

const never = () => new Promise<never>(() => undefined)

class Inventory {
  attempts = 0
  received: unknown[][] = []

  @Retry('inventory')
  async flaky(): Promise<string> {
    this.attempts++
    if (this.attempts < 3) {
      throw new Error('blip')
    }
    return 'ok'
  }

  @CircuitBreaker('inventory')
  async down(): Promise<string> {
    this.attempts++
    throw new Error('down')
  }

  @TimeLimiter('inventory')
  async hang(id: string, signal?: AbortSignal): Promise<string> {
    this.received.push([id, signal])
    return never()
  }

  @TimeLimiter('inventory')
  async busy(): Promise<string> {
    // Work before the first await, such as serializing a large payload: no timer can fire while it runs.
    vi.advanceTimersByTime(150)
    await Promise.resolve()
    return 'built'
  }

  @Bulkhead('inventory')
  async held(release: Promise<void>): Promise<string> {
    await release
    return 'done'
  }

  @RateLimiter('inventory')
  async quick(): Promise<string> {
    return 'ok'
  }

  @Fallback('cached')
  async failing(id: string): Promise<string> {
    throw new Error(`no stock for ${id}`)
  }

  async cached(error: unknown, id: string): Promise<string> {
    return `cached ${id} after ${(error as Error).message}`
  }

  // Calls an annotated method through `this`, the container's proxy.
  async outer(): Promise<string> {
    return this.flaky()
  }

  plain(): number {
    return 42
  }
}

describe('resilience annotations on a class the container builds', () => {
  it('retries a method with @Retry', async () => {
    const { di } = await containerWith(di => di.bind(Inventory, t => t.toSelf()))
    const inventory = di.get(Inventory)

    await expect(inventory.flaky()).resolves.toBe('ok')
    expect(inventory.attempts).toBe(3)
  })

  it('opens the breaker of @CircuitBreaker and refuses without running the method', async () => {
    const { di, registry } = await containerWith(di => di.bind(Inventory, t => t.toSelf()))
    const inventory = di.get(Inventory)

    await inventory.down().catch(() => undefined)
    await inventory.down().catch(() => undefined)
    const refused = await inventory.down().catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(ErrCallNotPermitted)
    expect(inventory.attempts).toBe(2)
    expect(registry.circuitBreaker('inventory').state).toBe('open')
  })

  it('rejects a method with @TimeLimiter at its limit', async () => {
    const { di } = await containerWith(di => di.bind(Inventory, t => t.toSelf()))

    const call = di
      .get(Inventory)
      .hang('42')
      .catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)

    expect(await call).toBeInstanceOf(ErrTimeLimitExceeded)
  })

  // The limit counts the method's own synchronous work, which no timer can interrupt.
  it('times out a method with @TimeLimiter whose work before its first await outruns the limit', async () => {
    const { di } = await containerWith(di => di.bind(Inventory, t => t.toSelf()))

    await expect(di.get(Inventory).busy()).rejects.toBeInstanceOf(ErrTimeLimitExceeded)
  })

  it('caps the calls of a method with @Bulkhead', async () => {
    const { di } = await containerWith(di => di.bind(Inventory, t => t.toSelf()))
    const inventory = di.get(Inventory)
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))

    const first = inventory.held(gate)
    await expect(inventory.held(gate)).rejects.toBeInstanceOf(ErrBulkheadFull)
    release()
    await expect(first).resolves.toBe('done')
  })

  it('limits how often a method with @RateLimiter starts', async () => {
    const { di } = await containerWith(di => di.bind(Inventory, t => t.toSelf()))
    const inventory = di.get(Inventory)

    await expect(inventory.quick()).resolves.toBe('ok')
    await expect(inventory.quick()).rejects.toBeInstanceOf(ErrRateLimitExceeded)
  })

  it('answers a failed call with the @Fallback method, handed the error and the original arguments', async () => {
    const { di, registry } = await containerWith(di => di.bind(Inventory, t => t.toSelf()))

    await expect(di.get(Inventory).failing('42')).resolves.toBe('cached 42 after no stock for 42')
    expect(registry.fallbacks().map(stale => stale.name)).toEqual(['Inventory.failing'])
  })

  it('leaves an unannotated method as it is, synchronous', async () => {
    const { di } = await containerWith(di => di.bind(Inventory, t => t.toSelf()))

    expect(di.get(Inventory).plain()).toBe(42)
  })

  it('weaves a call the class makes to itself, through this', async () => {
    const { di } = await containerWith(di => di.bind(Inventory, t => t.toSelf()))
    const inventory = di.get(Inventory)

    await expect(inventory.outer()).resolves.toBe('ok')
    expect(inventory.attempts).toBe(3)
  })
})

describe('@Resilient', () => {
  class Stock {
    attempts = 0

    @Resilient('stock')
    async read(): Promise<string> {
      this.attempts++
      throw new Error('down')
    }

    // Only the time limiter changes; the retry and the breaker are the ones `read` uses.
    @Resilient('stock')
    @TimeLimiter('export')
    async export(signal?: AbortSignal): Promise<string> {
      this.attempts++
      await new Promise(resolve => setTimeout(resolve, 150))
      signal?.throwIfAborted()
      return 'exported'
    }
  }

  const definitions: ResilienceDefinitions = {
    stock: {
      retry: { maxAttempts: 2, backoff: 0 },
      circuitBreaker: { minimumNumberOfCalls: 4, slidingWindow: { type: 'count', size: 4 } },
      timeLimiter: { timeoutDuration: 100 * Millisecond },
    },
    export: { timeLimiter: { timeoutDuration: 1 * Second } },
  }

  it('runs the method through every policy of the preset, retry outside the breaker', async () => {
    const { di, registry } = await containerWith(di => di.bind(Stock, t => t.toSelf()), definitions)
    const stock = di.get(Stock)

    await expect(stock.read()).rejects.toThrow('down')
    await expect(stock.read()).rejects.toThrow('down')

    expect(stock.attempts).toBe(4)
    expect(registry.circuitBreaker('stock').state).toBe('open')
    await expect(stock.read()).rejects.toBeInstanceOf(ErrCallNotPermitted)
    expect(stock.attempts).toBe(4)
  })

  // A variant of one dependency must count its failures in the dependency's one breaker, or neither might open.
  it('replaces one policy with a stage annotation and keeps the preset’s other instances', async () => {
    const { di, registry } = await containerWith(di => di.bind(Stock, t => t.toSelf()), definitions)
    const stock = di.get(Stock)

    const exported = stock.export()
    await vi.advanceTimersByTimeAsync(150)
    await expect(exported).resolves.toBe('exported')

    registry.circuitBreaker('stock').transitionToOpen()
    await expect(stock.export()).rejects.toBeInstanceOf(ErrCallNotPermitted)
    expect(stock.attempts).toBe(1)
  })

  it('refuses a preset nothing defines, naming the decorator', async () => {
    class Misnamed {
      @Resilient('stok')
      async call(): Promise<string> {
        return 'ok'
      }
    }
    const { di } = await containerWith(di => di.bind(Misnamed, t => t.toSelf()), definitions)

    expect(() => di.get(ResilienceAspect).prepare(Misnamed)).toThrow(
      'Cannot weave "Misnamed.call": no preset named "stok" is defined\nPossible Solutions:\n' +
        "  - Define it with Resilience(r => r.preset('stok', p => ...))\n" +
        "  - Fix the name in @Resilient('stok')",
    )
  })

  it('refuses a stage annotation naming a preset that lacks that policy', async () => {
    class Ledger {
      @Bulkhead('export')
      async post(): Promise<string> {
        return 'ok'
      }
    }
    const { di } = await containerWith(di => di.bind(Ledger, t => t.toSelf()), definitions)

    expect(() => di.get(ResilienceAspect).prepare(Ledger)).toThrow(
      'Cannot weave "Ledger.post": preset "export" defines no bulkhead\nPossible Solutions:\n' +
        "  - Add one with r.preset('export', p => p.bulkhead({ ... }))\n" +
        '  - Name a preset that defines one in @Bulkhead(...)',
    )
  })
})

describe('class-level annotations and false', () => {
  const definitions: ResilienceDefinitions = {
    stock: { retry: { maxAttempts: 3, backoff: 0 }, timeLimiter: { timeoutDuration: 100 * Millisecond } },
    ledger: { retry: { maxAttempts: 2, backoff: 0 } },
  }

  @Resilient('stock')
  class Stock {
    calls: Record<string, number> = {}

    #count(name: string): number {
      this.calls[name] = (this.calls[name] ?? 0) + 1
      return this.calls[name]
    }

    async read(): Promise<string> {
      this.#count('read')
      throw new Error('down')
    }

    @Retry('ledger')
    async post(): Promise<string> {
      this.#count('post')
      throw new Error('down')
    }

    @Retry(false)
    async reserve(signal?: AbortSignal): Promise<string> {
      this.#count('reserve')
      await new Promise(resolve => setTimeout(resolve, 150))
      signal?.throwIfAborted()
      return 'reserved'
    }

    @Resilient(false)
    async release(): Promise<string> {
      this.#count('release')
      throw new Error('down')
    }

    // Returns a promise, but without `async`: nothing at run time says so.
    plain(): Promise<string> {
      this.#count('plain')
      return Promise.reject(new Error('down'))
    }

    @Fallback('cached')
    async guarded(): Promise<string> {
      this.#count('guarded')
      throw new Error('down')
    }

    async cached(): Promise<string> {
      this.#count('cached')
      throw new Error('cache down')
    }
  }

  it('runs every async method of the class through the class’s preset', async () => {
    const { di } = await containerWith(di => di.bind(Stock, t => t.toSelf()), definitions)
    const stock = di.get(Stock)

    await expect(stock.read()).rejects.toThrow('down')

    expect(stock.calls.read).toBe(3)
  })

  it('lets a method’s own annotation win, kind by kind', async () => {
    const { di } = await containerWith(di => di.bind(Stock, t => t.toSelf()), definitions)
    const stock = di.get(Stock)

    await expect(stock.post()).rejects.toThrow('down')

    expect(stock.calls.post).toBe(2)
  })

  it('takes one policy away with false and keeps the rest', async () => {
    const { di } = await containerWith(di => di.bind(Stock, t => t.toSelf()), definitions)
    const stock = di.get(Stock)

    const call = stock.reserve().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(150)

    expect(await call).toBeInstanceOf(ErrTimeLimitExceeded)
    expect(stock.calls.reserve).toBe(1)
  })

  it('keeps the class’s preset off a method with @Resilient(false)', async () => {
    const { di } = await containerWith(di => di.bind(Stock, t => t.toSelf()), definitions)
    const stock = di.get(Stock)

    await expect(stock.release()).rejects.toThrow('down')

    expect(stock.calls.release).toBe(1)
  })

  // A fallback method retried by the class would multiply every failure; a method without `async` is invisible.
  it('reaches neither a method a @Fallback names nor one declared without async', async () => {
    const { di } = await containerWith(di => di.bind(Stock, t => t.toSelf()), definitions)
    const stock = di.get(Stock)

    await expect(stock.plain()).rejects.toThrow('down')
    await expect(stock.guarded()).rejects.toThrow('cache down')

    expect(stock.calls).toEqual({ plain: 1, guarded: 3, cached: 1 })
  })

  // A class-level name reaches no method until one is added: a typo must not wait that long to be reported.
  @Resilient('stok')
  class Misnamed {
    read(): string {
      return 'sync'
    }
  }

  @TimeLimiter('ledger')
  class Unlimited {
    read(): string {
      return 'sync'
    }
  }

  it.each([
    [
      'a preset nothing defines',
      Misnamed,
      'Cannot weave "Misnamed": no preset named "stok" is defined\nPossible Solutions:\n' +
        "  - Define it with Resilience(r => r.preset('stok', p => ...))\n" +
        "  - Fix the name in @Resilient('stok')",
    ],
    [
      'a preset that lacks the policy',
      Unlimited,
      'Cannot weave "Unlimited": preset "ledger" defines no time limiter\nPossible Solutions:\n' +
        "  - Add one with r.preset('ledger', p => p.timeLimiter({ ... }))\n" +
        '  - Name a preset that defines one in @TimeLimiter(...)',
    ],
  ])('refuses a class-level annotation naming %s, even with no method it reaches', async (_, cls, message) => {
    const { di } = await containerWith(di => di.bind(cls, t => t.toSelf()), definitions)

    expect(() => di.get(ResilienceAspect).prepare(cls)).toThrow(message)
  })
})

// One fixed order, whatever order the decorators are written in: retry outside the breaker, so an open breaker fails
// the call at once instead of being retried.
describe('the order of the strategies', () => {
  class RetryWrittenFirst {
    attempts = 0

    @Retry('inventory')
    @CircuitBreaker('inventory')
    async call(): Promise<string> {
      this.attempts++
      throw new Error('down')
    }
  }

  class BreakerWrittenFirst {
    attempts = 0

    @CircuitBreaker('shared')
    @Retry('inventory')
    async call(): Promise<string> {
      this.attempts++
      throw new Error('down')
    }
  }

  it.each([
    ['@Retry written first', RetryWrittenFirst],
    ['@CircuitBreaker written first', BreakerWrittenFirst],
  ])('retries outside the breaker with %s', async (_, Target) => {
    const { di } = await containerWith(di => di.bind(Target, t => t.toSelf()))
    const target = di.get(Target)

    const error = await target.call().catch((reason: unknown) => reason)

    // Two attempts, then the breaker inside refused the third: a breaker outside would have let all three through.
    expect(target.attempts).toBe(2)
    expect((error as Error).message).toBe('down')
  })

  // With the breaker outside, one call counts once however many attempts it took.
  it('records a call once in the breaker when the order puts the breaker outside the retry', async () => {
    const { di, registry } = await containerWith(di => di.bind(RetryWrittenFirst, t => t.toSelf()), DEFINITIONS, {
      order: ['circuitBreaker', 'retry', 'rateLimiter', 'timeLimiter', 'bulkhead'],
    })
    const target = di.get(RetryWrittenFirst)

    await target.call().catch(() => undefined)

    expect(target.attempts).toBe(3)
    expect(registry.circuitBreaker('inventory').metrics().failedCalls).toBe(1)
  })

  it.each([
    [['retry', 'circuitBreaker', 'rateLimiter', 'timeLimiter'], 'order leaves out "bulkhead"'],
    [['retry', 'retry', 'circuitBreaker', 'rateLimiter', 'timeLimiter', 'bulkhead'], 'order names "retry" twice'],
    [
      ['fallback', 'retry', 'circuitBreaker', 'rateLimiter', 'timeLimiter', 'bulkhead'],
      'order names "fallback", which is always outermost',
    ],
    [['retry', 'cache', 'circuitBreaker'], 'order names "cache", which is not a policy kind'],
    ['retry', 'order must be an array, got a string'],
  ])('refuses the order %j', (order, reason) => {
    expect(() => new ResilienceAspect(new ResilienceRegistry(), order as never)).toThrow(ErrInvalidOption)
    expect(() => new ResilienceAspect(new ResilienceRegistry(), order as never)).toThrow(
      `Cannot order the resilience policies: ${reason}`,
    )
  })
})

// Inside the time limiter, the bulkhead gives a slot back when the call really ends: a call the time limiter gave up on
// may still be running, and a new call in its slot would put one more on a dependency that is already slow.
describe('the bulkhead inside the time limiter', () => {
  class Pooled {
    calls = 0

    @TimeLimiter('pooled')
    @Bulkhead('pooled')
    async call(): Promise<string> {
      this.calls++
      // Ignores its signal, as a driver without cancellation does.
      await new Promise(resolve => setTimeout(resolve, 300))
      return 'ok'
    }
  }

  class Queued {
    @CircuitBreaker('queued')
    @TimeLimiter('queued')
    @Bulkhead('queued')
    @RateLimiter('queued')
    async call(): Promise<string> {
      await new Promise(resolve => setTimeout(resolve, 80))
      return 'ok'
    }
  }

  const queued = (bulkheadWait: number, rateLimiterWait = 0): ResilienceDefinitions => ({
    queued: {
      circuitBreaker: { minimumNumberOfCalls: 2, slidingWindow: { type: 'count', size: 2 } },
      timeLimiter: { timeoutDuration: 100 * Millisecond },
      bulkhead: { maxConcurrentCalls: 1, maxQueuedCalls: 5, maxWaitDuration: bulkheadWait },
      rateLimiter: { limitForPeriod: 100, limitRefreshPeriod: 1 * Second, maxWaitDuration: rateLimiterWait },
    },
  })

  it('keeps the slot of a call that timed out until the call ends', async () => {
    const { di } = await containerWith(di => di.bind(Pooled, t => t.toSelf()), {
      pooled: { timeLimiter: { timeoutDuration: 100 * Millisecond }, bulkhead: { maxConcurrentCalls: 1 } },
    })
    const pooled = di.get(Pooled)

    const first = pooled.call().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(await first).toBeInstanceOf(ErrTimeLimitExceeded)
    expect(await pooled.call().catch((error: unknown) => error)).toBeInstanceOf(ErrBulkheadFull)

    await vi.advanceTimersByTimeAsync(200)
    void pooled.call().catch(() => undefined)
    expect(pooled.calls).toBe(2)
  })

  // A call still waiting for a slot when the limit passes would time out, and open the breaker on a dependency that
  // answers every call in time; refused by the bulkhead, it is ignored by the breaker.
  it('refuses a bulkhead that may wait as long as the time limit around it', async () => {
    const { di } = await containerWith(di => di.bind(Queued, t => t.toSelf()), queued(100 * Millisecond))

    expect(() => di.get(ResilienceAspect).prepare(Queued)).toThrow(ErrInvalidOption)
    expect(() => di.get(ResilienceAspect).prepare(Queued)).toThrow(
      'Cannot weave "Queued.call": bulkhead "queued" may wait 100ms, not less than the 100ms limit of time limiter ' +
        '"queued" around it, so a waiting call would time out instead of being refused',
    )
    expect(() => di.get(ResilienceAspect).prepare(Queued)).toThrow(
      "Order the bulkhead outside the time limiter with r.order(['retry', 'circuitBreaker', 'rateLimiter', 'bulkhead', 'timeLimiter'])",
    )
  })

  it('accepts a bulkhead whose wait ends before the time limit around it', async () => {
    const { di } = await containerWith(di => di.bind(Queued, t => t.toSelf()), queued(99 * Millisecond))

    expect(() => di.get(ResilienceAspect).prepare(Queued)).not.toThrow()
  })

  it('refuses a rate limiter that may wait as long as the time limit, when the order puts it inside', async () => {
    const order: ResilienceKind[] = ['retry', 'circuitBreaker', 'timeLimiter', 'rateLimiter', 'bulkhead']
    const definitions = queued(0, 1 * Second)
    const inside = await containerWith(di => di.bind(Queued, t => t.toSelf()), definitions, { order })
    const outside = await containerWith(di => di.bind(Queued, t => t.toSelf()), definitions)

    expect(() => inside.di.get(ResilienceAspect).prepare(Queued)).toThrow(
      'Cannot weave "Queued.call": rate limiter "queued" may wait 1s, not less than the 100ms limit of time limiter',
    )
    expect(() => outside.di.get(ResilienceAspect).prepare(Queued)).not.toThrow()
  })

  // Outside the time limiter, the wait for a slot is the process's own queue and the limit times the running call.
  it('times only the running call when the order puts the bulkhead outside the time limiter', async () => {
    const { di, registry } = await containerWith(di => di.bind(Queued, t => t.toSelf()), queued(1 * Second), {
      order: ['retry', 'circuitBreaker', 'rateLimiter', 'bulkhead', 'timeLimiter'],
    })
    const target = di.get(Queued)

    const calls = Promise.all([target.call(), target.call(), target.call()].map(call => call.catch((e: unknown) => e)))
    await vi.advanceTimersByTimeAsync(240)

    expect(await calls).toEqual(['ok', 'ok', 'ok'])
    expect(registry.circuitBreaker('queued').metrics().failedCalls).toBe(0)
  })
})

describe('what is woven', () => {
  class Orders {
    attempts = 0

    @CircuitBreaker('shared')
    async place(): Promise<string> {
      this.attempts++
      throw new Error('down')
    }
  }

  class Payments {
    attempts = 0

    @CircuitBreaker('shared')
    async charge(): Promise<string> {
      this.attempts++
      return 'charged'
    }
  }

  // One name, one state: a dependency's failures seen through one class must open the breaker for the other.
  it('shares the state of a name between classes', async () => {
    const { di } = await containerWith(di => {
      di.bind(Orders, t => t.toSelf())
      di.bind(Payments, t => t.toSelf())
    })

    await di
      .get(Orders)
      .place()
      .catch(() => undefined)
    await di
      .get(Orders)
      .place()
      .catch(() => undefined)

    await expect(di.get(Payments).charge()).rejects.toBeInstanceOf(ErrCallNotPermitted)
    expect(di.get(Payments).attempts).toBe(0)
  })

  it('keeps one breaker for every instance of a transient class', async () => {
    const { di } = await containerWith(di => di.bind(Orders, t => t.toSelf().lifetime(Scopes.TRANSIENT)))
    const first = di.get(Orders)
    const second = di.get(Orders)

    await first.place().catch(() => undefined)
    await first.place().catch(() => undefined)

    expect(second).not.toBe(first)
    await expect(second.place()).rejects.toBeInstanceOf(ErrCallNotPermitted)
    expect(second.attempts).toBe(0)
  })

  it('weaves a subclass that inherits an annotated method', async () => {
    class Child extends Inventory {}
    const { di } = await containerWith(di => di.bind(Child, t => t.toSelf()))
    const child = di.get(Child)

    await expect(child.flaky()).resolves.toBe('ok')
    expect(child.attempts).toBe(3)
  })

  // The annotation's inherit rule is the nearest declaration: an override that declares none keeps its base's.
  it('weaves an override that declares no annotation of its own with its base’s', async () => {
    class Override extends Inventory {
      override async flaky(): Promise<string> {
        this.attempts++
        if (this.attempts < 2) {
          throw new Error('blip')
        }
        return 'overridden'
      }
    }
    const { di } = await containerWith(di => di.bind(Override, t => t.toSelf()))
    const override = di.get(Override)

    await expect(override.flaky()).resolves.toBe('overridden')
    expect(override.attempts).toBe(2)
  })

  it('leaves alone an instance the container did not build', async () => {
    await containerWith(di => di.bind(Inventory, t => t.toSelf()))
    const own = new Inventory()

    await expect(own.flaky()).rejects.toThrow('blip')
    expect(own.attempts).toBe(1)
  })

  it('leaves alone a value or a factory bound without a class', async () => {
    const kValue = token<Inventory>('value')
    const kFactory = token<Inventory>('factory')
    const { di } = await containerWith(di => {
      di.bind(kValue, t => t.toValue(new Inventory()))
      di.bind(kFactory, t => t.toFactory(() => new Inventory()))
    })

    await expect(di.get(kValue).flaky()).rejects.toThrow('blip')
    await expect(di.get(kFactory).flaky()).rejects.toThrow('blip')
  })

  @Injectable()
  @Profile('resilience-aop-injectable')
  class InjectableInventory {
    attempts = 0

    @Retry('inventory')
    async flaky(): Promise<string> {
      this.attempts++
      if (this.attempts < 2) {
        throw new Error('blip')
      }
      return 'ok'
    }
  }

  it('weaves a class registered with @Injectable', async () => {
    const { di } = await containerWith(() => undefined, DEFINITIONS, { profiles: ['resilience-aop-injectable'] })
    const inventory = di.get(InjectableInventory)

    await expect(inventory.flaky()).resolves.toBe('ok')
    expect(inventory.attempts).toBe(2)
  })
})

describe('the signal argument', () => {
  it('hands the method the attempt’s signal in place of the caller’s, aborted at the limit', async () => {
    const { di } = await containerWith(di => di.bind(Inventory, t => t.toSelf()))
    const inventory = di.get(Inventory)
    const caller = new AbortController()

    const call = inventory.hang('42', caller.signal).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(100)
    await call

    const [id, signal] = inventory.received[0]!
    expect(id).toBe('42')
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal).not.toBe(caller.signal)
    expect((signal as AbortSignal).reason).toBeInstanceOf(ErrTimeLimitExceeded)
  })

  it('aborts the method’s signal when the caller aborts', async () => {
    const { di } = await containerWith(di => di.bind(Inventory, t => t.toSelf()))
    const inventory = di.get(Inventory)
    const caller = new AbortController()
    const reason = new Error('caller left')

    const call = inventory.hang('42', caller.signal).catch((error: unknown) => error)
    caller.abort(reason)

    expect(await call).toBe(reason)
    expect((inventory.received[0]![1] as AbortSignal).reason).toBe(reason)
  })

  // A method can hand back work that outlives it, such as a body to stream: the caller leaving later must still reach
  // it, though the limit no longer times it.
  it('aborts the method’s signal when the caller aborts after the method returned, and not at the limit', async () => {
    class Feed {
      signal: AbortSignal | undefined

      @TimeLimiter('inventory')
      async open(signal?: AbortSignal): Promise<string> {
        this.signal = signal
        return 'opened'
      }
    }
    const { di } = await containerWith(di => di.bind(Feed, t => t.toSelf()))
    const feed = di.get(Feed)
    const caller = new AbortController()
    const reason = new Error('caller left')

    await expect(feed.open(caller.signal)).resolves.toBe('opened')
    await vi.advanceTimersByTimeAsync(1000)
    expect(feed.signal!.aborted).toBe(false)

    caller.abort(reason)

    expect(feed.signal!.aborted).toBe(true)
    expect(feed.signal!.reason).toBe(reason)
  })

  it('passes the arguments through untouched when no strategy derives a signal', async () => {
    class Echo {
      seen: unknown[] = []

      @Retry('inventory')
      async echo(payload: object, signal?: AbortSignal): Promise<void> {
        this.seen.push(payload, signal)
      }
    }
    const { di } = await containerWith(di => di.bind(Echo, t => t.toSelf()))
    const echo = di.get(Echo)
    const payload = { id: 42 }
    const caller = new AbortController()

    await echo.echo(payload, caller.signal)

    expect(echo.seen[0]).toBe(payload)
    expect(echo.seen[1]).toBe(caller.signal)
  })

  it('keeps the arguments and signals of interleaved calls apart', async () => {
    const { di } = await containerWith(di => di.bind(Inventory, t => t.toSelf()))
    const inventory = di.get(Inventory)
    const one = new AbortController()
    const two = new AbortController()

    const first = inventory.hang('1', one.signal).catch(() => undefined)
    const second = inventory.hang('2', two.signal).catch(() => undefined)
    one.abort(new Error('one'))
    await first

    expect(inventory.received.map(([id]) => id)).toEqual(['1', '2'])
    expect((inventory.received[0]![1] as AbortSignal).aborted).toBe(true)
    expect((inventory.received[1]![1] as AbortSignal).aborted).toBe(false)
    two.abort()
    await second
  })
})

describe('other aspects', () => {
  const log: string[] = []

  class Ledger {
    attempts = 0

    @Retry('inventory')
    async record(): Promise<string> {
      this.attempts++
      log.push(`attempt ${this.attempts}`)
      if (this.attempts < 3) {
        throw new Error('deadlock')
      }
      return 'recorded'
    }
  }

  class UnitOfWork implements MethodAspect<Ledger> {
    async around(jp: JoinPoint<Ledger>): Promise<unknown> {
      log.push('open')
      try {
        return await jp.proceed(...jp.args)
      } finally {
        log.push('close')
      }
    }
  }

  // A retry outside a transaction aspect must give each attempt a transaction of its own.
  it('runs an aspect with no order once per attempt, inside the retry', async () => {
    log.length = 0
    const { di } = await containerWith(di => {
      di.bind(Ledger, t => t.toSelf())
      di.aspect(UnitOfWork, s => s.toSelf().pointcuts($aop.forClass(Ledger, 'record')))
    })

    await expect(di.get(Ledger).record()).resolves.toBe('recorded')

    expect(log).toEqual(['open', 'attempt 1', 'close', 'open', 'attempt 2', 'close', 'open', 'attempt 3', 'close'])
  })

  it('runs an aspect ordered before it once, around every attempt', async () => {
    log.length = 0
    const { di } = await containerWith(di => {
      di.bind(Ledger, t => t.toSelf())
      di.aspect(UnitOfWork, s => s.toSelf().pointcuts($aop.forClass(Ledger, 'record')).order(-1))
    })

    await expect(di.get(Ledger).record()).resolves.toBe('recorded')

    expect(log).toEqual(['open', 'attempt 1', 'attempt 2', 'attempt 3', 'close'])
  })
})

describe('preparing a class', () => {
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

  it('refuses a name nothing defines, naming the method', async () => {
    const { di } = await containerWith(di => di.bind(Misnamed, t => t.toSelf()))
    const aspect = di.get(ResilienceAspect)

    expect(() => aspect.prepare(Misnamed)).toThrow(ErrInvalidOption)
    expect(() => aspect.prepare(Misnamed)).toThrow(
      'Cannot weave "Misnamed.call": no preset named "inventroy" is defined',
    )
  })

  it('refuses a @Fallback that names no method of the class', async () => {
    const { di } = await containerWith(di => di.bind(MissingFallback, t => t.toSelf()))
    const aspect = di.get(ResilienceAspect)

    expect(() => aspect.prepare(MissingFallback)).toThrow(
      'Cannot weave "MissingFallback.call": @Fallback names "cachedStok", which is not a method of "MissingFallback"',
    )
  })

  // A native private member refuses any receiver but the instance its class built, so a woven method must run with it.
  it('runs an annotated method with the instance itself, so it can use private members', async () => {
    class Counter {
      #attempts = 0

      @Retry('inventory')
      async call(): Promise<number> {
        this.#attempts++
        if (this.#attempts < 2) {
          throw new Error('blip')
        }
        return this.#attempts
      }
    }
    const { di } = await containerWith(di => di.bind(Counter, t => t.toSelf()))

    await expect(di.get(Counter).call()).resolves.toBe(2)
  })

  class StaticLoader {
    @Retry('inventory')
    static async load(): Promise<string> {
      return 'ok'
    }
  }

  // No container builds a static method, so nothing would weave it: refused rather than silently ignored.
  it('refuses an annotation on a static method', async () => {
    const { di } = await containerWith(di => di.bind(StaticLoader, t => t.toSelf()))
    const aspect = di.get(ResilienceAspect)

    expect(() => aspect.prepare(StaticLoader)).toThrow(
      'Cannot weave "StaticLoader.load": @Retry is on a static method, which is never woven',
    )
  })

  class PrivateLoader {
    @Retry('inventory')
    async #load(): Promise<string> {
      return 'ok'
    }

    async load(): Promise<string> {
      return this.#load()
    }
  }

  // A private method is called by name inside its class, never through a property, so nothing would weave it.
  it('refuses an annotation on a private method', async () => {
    const { di } = await containerWith(di => di.bind(PrivateLoader, t => t.toSelf()))
    const aspect = di.get(ResilienceAspect)

    expect(() => aspect.prepare(PrivateLoader)).toThrow(
      'Cannot weave "PrivateLoader.#load": @Retry is on a private method, which is never woven',
    )
  })

  // An annotated method returns a promise: a plan that cannot be built rejects it rather than throwing.
  it('rejects the call of a method whose plan cannot be built', async () => {
    const { di } = await containerWith(di => di.bind(Misnamed, t => t.toSelf()))

    await expect(di.get(Misnamed).call()).rejects.toThrow(
      'Cannot weave "Misnamed.call": no preset named "inventroy" is defined',
    )
  })
})

describe('the frame each attempt runs in', () => {
  const kCaller = contextKey<string>('caller')
  // A real timer runs its callback in the frame it was set in; a fake one runs it in the test's. The rate limiter sets
  // the timer of each waiting call from the callback that woke the one before it.
  const contextClock: Clock = {
    ...fakeTimersClock,
    setTimeout: (callback, delay) => fakeTimersClock.setTimeout(AsyncLocalStorage.bind(callback), delay),
  }

  // What the code below each call saw of its caller's frame, in the order the attempts ran.
  class Tenanted {
    seen: Array<string | undefined> = []
    readonly #first = Promise.withResolvers<void>()
    storage!: ContextStorage

    release(): void {
      this.#first.resolve()
    }

    @Bulkhead('queued')
    async queued(): Promise<void> {
      this.seen.push(this.storage.getStore()?.get(kCaller))
      if (this.seen.length === 1) {
        await this.#first.promise
      }
    }

    @RateLimiter('limited')
    async limited(): Promise<void> {
      this.seen.push(this.storage.getStore()?.get(kCaller))
    }
  }

  async function tenanted() {
    const storage = new AsyncLocalStorage<ExecutionContext>()
    const { di } = await containerWith(
      d => d.bind(Tenanted, t => t.toSelf()),
      {
        queued: { bulkhead: { maxConcurrentCalls: 1, maxWaitDuration: 1 * Second } },
        limited: {
          rateLimiter: {
            limitForPeriod: 1,
            limitRefreshPeriod: 100 * Millisecond,
            maxWaitDuration: 1 * Second,
            clock: contextClock,
          },
        },
      },
      { storage },
    )
    const service = di.get(Tenanted)
    service.storage = storage
    const as = <T>(caller: string, fn: () => Promise<T>) => storage.run(ExecutionContext.ROOT.with(kCaller, caller), fn)
    return { service, as }
  }

  // A call that waited for a slot runs when another call ends, from that call's continuation: it must still see its
  // own caller, or it reads another request's tenant, context and request-scoped services.
  it('extends the caller’s frame for a call that waited in a bulkhead', async () => {
    const { service, as } = await tenanted()

    const a = as('a', () => service.queued())
    const b = as('b', () => service.queued())
    await vi.advanceTimersByTimeAsync(0)
    service.release()
    await Promise.all([a, b])

    expect(service.seen).toEqual(['a', 'b'])
  })

  // The third call is woken by a timer the second call's wake-up set, in the second caller's frame.
  it('extends the caller’s frame for each call that waited for a rate limiter permit', async () => {
    const { service, as } = await tenanted()

    const calls = ['a', 'b', 'c'].map(caller => as(caller, () => service.limited()))
    await vi.advanceTimersByTimeAsync(200)
    await Promise.all(calls)

    expect(service.seen).toEqual(['a', 'b', 'c'])
  })
})
