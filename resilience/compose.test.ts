import { describe, expect, expectTypeOf, it } from 'vitest'

import { circuitBreaker } from './circuit_breaker/circuit_breaker.js'
import { compose, runWith } from './compose.js'
import { ErrCallNotPermitted, ErrInvalidOption } from './errors.js'
import { retry } from './retry/retry.js'
import type { ExecutionContext, Next, Strategy, StrategyObject } from './strategy.js'

function recorder(log: string[], name: string): Strategy {
  return async (ctx, next) => {
    log.push(`${name}:enter`)
    try {
      return await next(ctx)
    } finally {
      log.push(`${name}:exit`)
    }
  }
}

describe('runWith', () => {
  // The order decides semantics (retry around a breaker is not a breaker around a retry), so it must be the
  // reading order of the arguments.
  it('runs strategies from the outermost to the innermost, so the first one listed sees the call first', async () => {
    const log: string[] = []

    await runWith(() => log.push('op'), recorder(log, 'a'), recorder(log, 'b'))

    expect(log).toEqual(['a:enter', 'b:enter', 'op', 'b:exit', 'a:exit'])
  })

  it('delivers a sync value as a resolved promise', async () => {
    await expect(runWith(() => 42)).resolves.toBe(42)
  })

  // A caller that chains .catch() must see every failure there, not as an exception thrown by the call itself.
  it('delivers a sync throw from the operation as a rejection, never as a synchronous throw', async () => {
    const boom = new Error('boom')
    let result: Promise<never> | undefined

    expect(() => {
      result = runWith(() => {
        throw boom
      })
    }).not.toThrow()
    await expect(result).rejects.toBe(boom)
  })

  it('delivers a strategy that throws synchronously as a rejection', async () => {
    const boom = new Error('boom')
    const broken: Strategy = () => {
      throw boom
    }
    let result: Promise<number> | undefined

    expect(() => {
      result = runWith(() => 1, recorder([], 'outer'), broken)
    }).not.toThrow()
    await expect(result).rejects.toBe(boom)
    await expect(runWith(() => 1, broken)).rejects.toBe(boom)
  })

  it('delivers a first strategy that returns a plain value as a resolved promise', async () => {
    const plainValue = (() => 42) as unknown as Strategy

    const result = runWith(() => 1, plainValue)

    expect(result).toBeInstanceOf(Promise)
    await expect(result).resolves.toBe(42)
  })

  // A strategy chains on next(ctx) with .then or .finally; a synchronous throw or a bare value there would skip its
  // cleanup, whatever a strategy further in does wrong.
  it('hands every strategy a next that returns a promise and never throws, whatever the strategy inside it does', async () => {
    const boom = new Error('boom')
    const throwing: Strategy = () => {
      throw boom
    }
    const plainValue = (() => 42) as unknown as Strategy
    const seen: string[] = []
    const probe: Strategy = (ctx, next) => {
      try {
        const result = next(ctx)
        seen.push(result instanceof Promise ? 'promise' : 'value')
        return result
      } catch (error) {
        seen.push('throw')
        throw error
      }
    }

    await expect(runWith(() => 1, probe, throwing)).rejects.toBe(boom)
    await expect(runWith(() => 1, probe, plainValue)).resolves.toBe(42)

    expect(seen).toEqual(['promise', 'promise'])
  })

  it('hands a trailing signal to the operation', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined

    await runWith(ctx => (seen = ctx.signal), recorder([], 'a'), controller.signal)

    expect(seen).toBe(controller.signal)
  })

  // `getStock(id, signal?)` passes an optional signal straight through; `undefined` there must not be mistaken for a
  // missing strategy.
  it('treats a trailing undefined as "no signal" and still runs every strategy', async () => {
    const log: string[] = []
    let seen: AbortSignal | undefined = new AbortController().signal

    await runWith(ctx => (seen = ctx.signal), recorder(log, 'a'), undefined)

    expect(seen).toBeUndefined()
    expect(log).toEqual(['a:enter', 'a:exit'])
  })

  it('rejects with the abort reason without running anything when the signal is already aborted', async () => {
    const reason = new Error('caller gave up')
    const log: string[] = []

    await expect(runWith(() => log.push('op'), recorder(log, 'a'), AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(log).toEqual([])
  })

  // A wrong argument is a programming error; failing at the call site points straight at it.
  it('throws ErrInvalidOption synchronously for an argument that is not a strategy', () => {
    expect(() => runWith(() => 1, 42 as never, recorder([], 'a'))).toThrow(ErrInvalidOption)
    expect(() => runWith(() => 1, recorder([], 'a'), 42 as never)).toThrow(ErrInvalidOption)
    expect(() => runWith(() => 1, { run: 'nope' } as never)).toThrow(
      'Cannot run: the last argument is neither a strategy nor an AbortSignal',
    )
  })

  it('accepts function and object strategies in one chain and calls an object strategy with itself as this', async () => {
    const counting = {
      calls: 0,
      run<T>(ctx: ExecutionContext, next: Next<T>): Promise<T> {
        this.calls++
        return next(ctx)
      },
    }

    await runWith(() => 1, recorder([], 'a'), counting)
    await runWith(() => 1, counting, recorder([], 'a'))

    expect(counting.calls).toBe(2)
  })

  it('accepts a class implementing StrategyObject', async () => {
    class Counting implements StrategyObject {
      calls = 0

      run<T>(ctx: ExecutionContext, next: Next<T>): Promise<T> {
        this.calls++
        return next(ctx)
      }
    }
    const counting = new Counting()

    await runWith(() => 1, counting)

    expect(counting.calls).toBe(1)
  })

  // A strategy that derives a signal (a deadline, say) must be able to hand it to everything inside it.
  it('lets a strategy hand the inner chain a derived context without touching the original', async () => {
    const outer = new AbortController()
    const inner = new AbortController()
    let original: ExecutionContext | undefined
    let seen: ExecutionContext | undefined

    const deriving: Strategy = (ctx, next) => {
      original = ctx
      return next(ctx.with({ signal: inner.signal, attempt: 3 }))
    }

    await runWith(ctx => (seen = ctx), deriving, outer.signal)

    expect(seen?.signal).toBe(inner.signal)
    expect(seen?.attempt).toBe(3)
    expect(original?.signal).toBe(outer.signal)
    expect(original?.attempt).toBe(1)
  })

  it('removes the signal when a derived context sets it to undefined, and keeps the attempt', async () => {
    let seen: ExecutionContext | undefined
    const dropping: Strategy = (ctx, next) => next(ctx.with({ signal: undefined }))

    await runWith(ctx => (seen = ctx), dropping, new AbortController().signal)

    expect(seen?.signal).toBeUndefined()
    expect(seen?.attempt).toBe(1)
  })

  it('rejects with ErrInvalidOption when a strategy hands next a context it built itself', async () => {
    const forging: Strategy = (ctx, next) => next({ ...ctx })

    await expect(runWith(() => 1, forging)).rejects.toThrow(ErrInvalidOption)
  })

  it('types the result as a promise of the awaited operation result', () => {
    expectTypeOf(runWith(() => 1)).toEqualTypeOf<Promise<number>>()
    expectTypeOf(runWith(async () => 1)).toEqualTypeOf<Promise<number>>()
    expectTypeOf(runWith(() => 'x', recorder([], 'a'), undefined)).toEqualTypeOf<Promise<string>>()
    expectTypeOf(compose()(() => 1)).toEqualTypeOf<Promise<number>>()
    expectTypeOf(compose(recorder([], 'a'))(async () => true)).toEqualTypeOf<Promise<boolean>>()
  })
})

describe('compose', () => {
  it('runs the operation directly when given no strategies, and still returns a promise', async () => {
    const run = compose()

    const result = run(() => 7)

    expect(result).toBeInstanceOf(Promise)
    await expect(result).resolves.toBe(7)
  })

  it('delivers a first strategy that throws synchronously as a rejection, never as a synchronous throw', async () => {
    const boom = new Error('boom')
    const broken: Strategy = () => {
      throw boom
    }
    const run = compose(broken)
    let result: Promise<number> | undefined

    expect(() => {
      result = run(() => 1)
    }).not.toThrow()
    await expect(result).rejects.toBe(boom)
  })

  it('delivers a first strategy that returns a plain value as a resolved promise', async () => {
    const plainValue = (() => 42) as unknown as Strategy

    const result = compose(plainValue)(() => 1)

    expect(result).toBeInstanceOf(Promise)
    await expect(result).resolves.toBe(42)
  })

  it('orders strategies the same way as runWith', async () => {
    const log: string[] = []

    await compose(recorder(log, 'a'), recorder(log, 'b'))(() => log.push('op'))

    expect(log).toEqual(['a:enter', 'b:enter', 'op', 'b:exit', 'a:exit'])
  })

  it('throws ErrInvalidOption synchronously for an argument that is not a strategy', () => {
    expect(() => compose(recorder([], 'a'), null as never)).toThrow(
      'Cannot compose: strategy #2 is neither a function nor an object with a run() method',
    )
  })

  it('reports the first invalid argument when several are invalid', () => {
    expect(() => compose(recorder([], 'a'), 1 as never, null as never)).toThrow('strategy #2')
  })

  // One runner serves every request; the per-call context must never leak between concurrent calls.
  it('keeps each concurrent call on its own context while sharing the chain', async () => {
    const yielding: Strategy = async (ctx, next) => {
      await new Promise(resolve => setTimeout(resolve, 1))
      return next(ctx)
    }
    const run = compose(yielding)
    const first = new AbortController()
    const second = new AbortController()

    const seen = await Promise.all([run(ctx => ctx.signal, first.signal), run(ctx => ctx.signal, second.signal)])

    expect(seen).toEqual([first.signal, second.signal])
  })
})

describe('with the built-in strategies', () => {
  const alwaysFail = (): never => {
    throw new Error('down')
  }

  // Retry around the breaker lets the breaker see every attempt; the other way round it sees one call per sequence.
  it('counts each attempt in the breaker when the retry is outside it, and one call when it is inside', async () => {
    const outside = circuitBreaker({ name: 'outside', minimumNumberOfCalls: 100 })
    const inside = circuitBreaker({ name: 'inside', minimumNumberOfCalls: 100 })
    const retries = retry({ name: 'inventory', maxAttempts: 3, backoff: 0 })

    await runWith(alwaysFail, retries, outside).catch(() => undefined)
    await runWith(alwaysFail, inside, retries).catch(() => undefined)

    expect(outside.metrics().bufferedCalls).toBe(3)
    expect(inside.metrics().bufferedCalls).toBe(1)
  })

  it('fails fast through a retry when the breaker is open', async () => {
    const breaker = circuitBreaker({ name: 'inventory' })
    const retries = retry({ name: 'inventory', backoff: 60_000 })
    breaker.forceOpen()

    await expect(runWith(() => 'ok', retries, breaker)).rejects.toBeInstanceOf(ErrCallNotPermitted)
    expect(retries.metrics().failedCallsWithoutRetry).toBe(1)
  })

  it('keeps the attempt count of concurrent calls through one runner apart', async () => {
    const run = compose(retry({ name: 'inventory', backoff: 1 }))
    const flaky = () => {
      const attempts: number[] = []
      return {
        attempts,
        operation: (ctx: ExecutionContext) => {
          attempts.push(ctx.attempt)
          if (attempts.length === 1) {
            throw new Error('first attempt fails')
          }
          return attempts.length
        },
      }
    }
    const first = flaky()
    const second = flaky()

    await Promise.all([run(first.operation), run(second.operation)])

    expect(first.attempts).toEqual([1, 2])
    expect(second.attempts).toEqual([1, 2])
  })

  // Node keeps 10 frames by default. Every frame the chain puts between the caller and the operation is one of the
  // caller's that an error thrown synchronously in the operation loses.
  it('adds at most 2n + 1 frames between the caller and a synchronously throwing operation', async () => {
    const errorClass = Error as { stackTraceLimit?: number }
    const original = errorClass.stackTraceLimit
    errorClass.stackTraceLimit = 50
    try {
      const operationThatThrows = (): never => {
        throw new Error('sync')
      }
      const breaker = circuitBreaker({ name: 'inventory' })
      const retries = retry({ name: 'inventory', maxAttempts: 1 })
      const breakerOnly = compose(breaker)
      const retryAndBreaker = compose(retries, breaker)
      function callsTheBreaker(): Promise<unknown> {
        return breakerOnly(operationThatThrows)
      }
      function callsRetryAndBreaker(): Promise<unknown> {
        return retryAndBreaker(operationThatThrows)
      }
      function callsRunWith(): Promise<unknown> {
        return runWith(operationThatThrows, retries, breaker)
      }
      const framesBelow = async (caller: () => Promise<unknown>): Promise<number | undefined> => {
        const error = (await caller().catch((reason: unknown) => reason)) as Error
        const lines = error.stack?.split('\n') ?? []
        const operation = lines.findIndex(line => line.includes('operationThatThrows'))
        const entry = lines.findIndex(line => line.includes(caller.name))
        return operation > 0 && entry > operation ? entry - operation - 1 : undefined
      }

      expect(await framesBelow(callsTheBreaker)).toBeLessThanOrEqual(3)
      expect(await framesBelow(callsRetryAndBreaker)).toBeLessThanOrEqual(5)
      expect(await framesBelow(callsRunWith)).toBeLessThanOrEqual(5)
    } finally {
      errorClass.stackTraceLimit = original
    }
  })
})
