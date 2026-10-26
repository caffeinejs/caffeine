import {
  $aop,
  CaffeineIoC,
  Injectable,
  type JoinPoint,
  type MethodAspect,
  Profile,
  Scopes,
  token,
} from '@caffeinejs/di'
import { Hour, Millisecond } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrBulkheadFull } from '../bulkhead/bulkhead.js'
import { ErrCallNotPermitted } from '../circuitbreaker/circuitbreaker.js'
import { ErrInvalidOption } from '../errors.js'
import { useFakeClock } from '../fake_clock.testkit.js'
import { ErrRateLimitExceeded } from '../ratelimiter/ratelimiter.js'
import { ErrTimeLimitExceeded } from '../timelimiter/timelimiter.js'
import { Bulkhead, CircuitBreaker, Fallback, RateLimiter, Retry, TimeLimiter } from './annotations.js'
import { RESILIENCE_ASPECT_ORDER, ResilienceAspect, resiliencePointcut } from './aop.js'
import { type ResilienceDefinitions, ResilienceRegistry } from './registry.js'

beforeEach(() => {
  useFakeClock()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const DEFINITIONS: ResilienceDefinitions = {
  retries: { inventory: { maxAttempts: 3, backoff: 0 } },
  circuitBreakers: {
    inventory: { minimumNumberOfCalls: 2, slidingWindow: { type: 'count', size: 2 } },
    shared: { minimumNumberOfCalls: 2, slidingWindow: { type: 'count', size: 2 } },
  },
  timeLimiters: { inventory: { timeoutDuration: 100 * Millisecond } },
  bulkheads: { inventory: { maxConcurrentCalls: 1 } },
  rateLimiters: { inventory: { limitForPeriod: 1, limitRefreshPeriod: 1 * Hour } },
}

// A container with the aspect and a registry bound by hand, decorators off, so no fixture registers anywhere else.
async function containerWith(
  bind: (di: CaffeineIoC) => void,
  definitions: ResilienceDefinitions = DEFINITIONS,
  options: { profiles?: string[] } = {},
) {
  const di = new CaffeineIoC(options.profiles === undefined ? { decorators: false } : { profiles: options.profiles })
  const registry = new ResilienceRegistry(definitions)
  di.bind(ResilienceRegistry, t => t.toValue(registry))
  di.aspect(ResilienceAspect, s =>
    s.toSelf([ResilienceRegistry]).pointcuts(resiliencePointcut).order(RESILIENCE_ASPECT_ORDER),
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

    expect(target.attempts).toBe(2)
    expect(error).toBeInstanceOf(ErrCallNotPermitted)
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
      'Cannot weave "Misnamed.call": no circuit breaker named "inventroy" is defined',
    )
  })

  it('refuses a @Fallback that names no method of the class', async () => {
    const { di } = await containerWith(di => di.bind(MissingFallback, t => t.toSelf()))
    const aspect = di.get(ResilienceAspect)

    expect(() => aspect.prepare(MissingFallback)).toThrow(
      'Cannot weave "MissingFallback.call": @Fallback names "cachedStok", which is not a method of "MissingFallback"',
    )
  })

  // An annotated method returns a promise: a plan that cannot be built rejects it rather than throwing.
  it('rejects the call of a method whose plan cannot be built', async () => {
    const { di } = await containerWith(di => di.bind(Misnamed, t => t.toSelf()))

    await expect(di.get(Misnamed).call()).rejects.toThrow(
      'Cannot weave "Misnamed.call": no circuit breaker named "inventroy" is defined',
    )
  })
})
