import { describe, expect, it } from 'vitest'

import { circuitBreaker, ErrCallNotPermitted } from './circuitbreaker/circuitbreaker.js'
import { compose, decorate, run } from './compose.js'
import { ErrInvalidOption } from './errors.js'
import type { CallContext, Operation, Policy, Wrapper } from './policy.js'
import { retry } from './retry/retry.js'
import { timeLimiter } from './timelimiter/timelimiter.js'

function recorder(log: string[], name: string): Policy {
  return op => async (ctx, input) => {
    log.push(`${name}:enter`)
    try {
      return await op(ctx, input)
    } finally {
      log.push(`${name}:exit`)
    }
  }
}

// An operation that returns or throws synchronously, as untyped code can; the chain must still hand back a promise.
function sync<T>(fn: (ctx: CallContext) => T): Operation<T> {
  return fn as unknown as Operation<T>
}

describe('compose', () => {
  // The order decides semantics (retry around a breaker is not a breaker around a retry), so it must be the reading
  // order of the arguments.
  it('runs layers from the outermost to the innermost, so the first one listed sees the call first', async () => {
    const log: string[] = []

    await run(compose(recorder(log, 'a'), recorder(log, 'b'))(async () => log.push('op')))

    expect(log).toEqual(['a:enter', 'b:enter', 'op', 'b:exit', 'a:exit'])
  })

  it('runs the operation directly when given no layers, and still returns a promise', async () => {
    const result = compose()(sync(() => 7))({ signal: undefined }, undefined)

    expect(result).toBeInstanceOf(Promise)
    await expect(result).resolves.toBe(7)
  })

  // A caller that chains .catch() must see every failure there, not as an exception thrown by the call itself.
  it('delivers a synchronous throw from the operation as a rejection', async () => {
    const boom = new Error('boom')
    const guarded = compose(recorder([], 'a'))(
      sync(() => {
        throw boom
      }),
    )
    let result: Promise<never> | undefined

    expect(() => {
      result = guarded({ signal: undefined }, undefined)
    }).not.toThrow()
    await expect(result).rejects.toBe(boom)
  })

  // A breaker or a bulkhead chains on what the layer inside returns: a synchronous throw there would skip its handler
  // and keep its permit forever.
  it('delivers a layer whose operation throws synchronously as a rejection, so the layer outside settles', async () => {
    const boom = new Error('boom')
    const broken: Policy = () => () => {
      throw boom
    }
    const breaker = circuitBreaker({ name: 'inventory' })
    const guarded = compose(breaker, broken)(async () => 1)

    await expect(guarded({ signal: undefined }, undefined)).rejects.toBe(boom)
    expect(breaker.metrics().failedCalls).toBe(1)
  })

  it('delivers a layer whose operation returns a plain value as a resolved promise', async () => {
    const plainValue = (() => () => 42) as unknown as Policy

    const result = compose(recorder([], 'a'), plainValue)(async () => 1)({ signal: undefined }, undefined)

    expect(result).toBeInstanceOf(Promise)
    await expect(result).resolves.toBe(42)
  })

  it('hands every layer an operation that returns a promise and never throws, whatever the layer inside it does', async () => {
    const boom = new Error('boom')
    const throwing: Policy = () => () => {
      throw boom
    }
    const plainValue = (() => () => 42) as unknown as Policy
    const seen: string[] = []
    const probe: Policy = op => (ctx, input) => {
      try {
        const result = op(ctx, input)
        seen.push(result instanceof Promise ? 'promise' : 'value')
        return result
      } catch (error) {
        seen.push('throw')
        throw error
      }
    }

    await expect(run(compose(probe, throwing)(async () => 1))).rejects.toBe(boom)
    await expect(run(compose(probe, plainValue)(async () => 1))).resolves.toBe(42)

    expect(seen).toEqual(['promise', 'promise'])
  })

  it('accepts policy functions and instances with wrap() in one chain, calling wrap() with the instance as this', async () => {
    class Counting implements Wrapper {
      calls = 0
      wraps = 0

      wrap<T, I>(op: Operation<T, I>): Operation<T, I> {
        this.wraps++
        return (ctx, input) => {
          this.calls++
          return op(ctx, input)
        }
      }
    }
    const counting = new Counting()
    const guarded = compose(recorder([], 'a'), counting, recorder([], 'b'))(async () => 1)

    await run(guarded)
    await run(guarded)

    expect(counting.wraps).toBe(1)
    expect(counting.calls).toBe(2)
  })

  // A wrong argument is a programming error; failing where the chain is built points straight at it.
  it('throws ErrInvalidOption for a layer that is neither a function nor an instance, naming the first one', () => {
    expect(() => compose(recorder([], 'a'), null as never)).toThrow(
      'Cannot compose: layer #2 is neither a function nor an object with a wrap() method',
    )
    expect(() => compose(recorder([], 'a'), 1 as never, { run: () => 1 } as never)).toThrow('layer #2')
    expect(() => compose(1 as never)).toThrow(ErrInvalidOption)
  })

  // One chain serves every request; a call must never see another call's context.
  it('keeps each concurrent call on its own context while sharing the chain', async () => {
    const yielding: Policy = op => async (ctx, input) => {
      await new Promise(resolve => setTimeout(resolve, 1))
      return op(ctx, input)
    }
    const guarded = compose(yielding)(async ctx => ctx.signal)
    const first = new AbortController()
    const second = new AbortController()

    const seen = await Promise.all([run(guarded, first.signal), run(guarded, second.signal)])

    expect(seen).toEqual([first.signal, second.signal])
  })

  // A policy that derives a signal must be able to hand it to everything inside it, with nothing to validate.
  it('lets a layer hand the rest of the chain another signal with a plain object', async () => {
    const outer = new AbortController()
    const inner = new AbortController()
    let original: CallContext | undefined
    const deriving: Policy = op => (ctx, input) => {
      original = ctx
      return op({ ...ctx, signal: inner.signal }, input)
    }

    const seen = await run(
      compose(deriving)(async ctx => ctx.signal),
      outer.signal,
    )

    expect(seen).toBe(inner.signal)
    expect(original?.signal).toBe(outer.signal)
  })

  it('composes a composed policy as a layer', async () => {
    const log: string[] = []
    const inner = compose(recorder(log, 'b'), recorder(log, 'c'))

    await run(compose(recorder(log, 'a'), inner)(async () => log.push('op')))

    expect(log).toEqual(['a:enter', 'b:enter', 'c:enter', 'op', 'c:exit', 'b:exit', 'a:exit'])
  })
})

describe('run', () => {
  it('hands the signal to the operation', async () => {
    const controller = new AbortController()

    await expect(run(async ctx => ctx.signal, controller.signal)).resolves.toBe(controller.signal)
    await expect(run(async ctx => ctx.signal)).resolves.toBeUndefined()
  })

  it('delivers a synchronous value or throw as a promise', async () => {
    const boom = new Error('boom')
    let result: Promise<never> | undefined

    await expect(run(sync(() => 42))).resolves.toBe(42)
    expect(() => {
      result = run(
        sync(() => {
          throw boom
        }),
      )
    }).not.toThrow()
    await expect(result).rejects.toBe(boom)
  })

  it('rejects with the abort reason without running anything when the signal is already aborted', async () => {
    const reason = new Error('caller gave up')
    const log: string[] = []

    await expect(
      run(
        compose(recorder(log, 'a'))(async () => log.push('op')),
        AbortSignal.abort(reason),
      ),
    ).rejects.toBe(reason)
    expect(log).toEqual([])
  })
})

describe('decorate', () => {
  it('keeps the function’s arguments and result', async () => {
    const log: string[] = []
    const add = decorate(recorder(log, 'a'), async (a: number, b: number) => a + b)

    await expect(add(2, 3)).resolves.toBe(5)
    expect(log).toEqual(['a:enter', 'a:exit'])
  })

  it('builds the chain once, not per call', async () => {
    let wraps = 0
    const counting: Wrapper = {
      wrap: op => {
        wraps++
        return op
      },
    }
    const guarded = decorate(counting, async (id: string) => id)

    await guarded('1')
    await guarded('2')

    expect(wraps).toBe(1)
  })

  it('takes the first AbortSignal argument as the caller’s signal', async () => {
    const caller = new AbortController()
    let seen: AbortSignal | undefined
    const observing: Policy = op => (ctx, input) => {
      seen = ctx.signal
      return op(ctx, input)
    }

    await decorate(observing, async (_id: string, _signal?: AbortSignal) => 1)('42', caller.signal)

    expect(seen).toBe(caller.signal)
  })

  it('rejects with the abort reason without calling the function when the caller’s signal is already aborted', async () => {
    const reason = new Error('caller gave up')
    let calls = 0

    await expect(
      decorate(recorder([], 'a'), async (_signal: AbortSignal) => calls++)(AbortSignal.abort(reason)),
    ).rejects.toBe(reason)
    expect(calls).toBe(0)
  })

  // A time limiter must be able to stop the work itself, so the function gets the signal the limiter owns.
  it('hands the function the attempt’s signal in place of the caller’s', async () => {
    const caller = new AbortController()
    let received: AbortSignal | undefined
    const guarded = decorate(
      timeLimiter({ name: 'inventory', timeoutDuration: 60_000 }),
      async (_id: string, signal?: AbortSignal) => {
        received = signal
        return 1
      },
    )

    await guarded('42', caller.signal)

    expect(received).toBeInstanceOf(AbortSignal)
    expect(received).not.toBe(caller.signal)
    caller.abort(new Error('client left'))
    expect(received?.aborted).toBe(true)
  })

  // Without a place for it, a signal the caller did not pass could never reach the function, and nothing would stop
  // the work at the time limit.
  it('puts the attempt’s signal at signalAt even when the caller passed none', async () => {
    let received: AbortSignal | undefined
    const guarded = decorate(
      timeLimiter({ name: 'inventory', timeoutDuration: 60_000 }),
      async (_id: string, signal?: AbortSignal) => {
        received = signal
        return 1
      },
      { signalAt: 1 },
    )

    await guarded('42')

    expect(received).toBeInstanceOf(AbortSignal)
  })

  it('reads the caller’s signal at signalAt, ignoring a signal elsewhere', async () => {
    const first = new AbortController()
    const second = new AbortController()
    let seen: AbortSignal | undefined
    const observing: Policy = op => (ctx, input) => {
      seen = ctx.signal
      return op(ctx, input)
    }

    await decorate(observing, async (_a: AbortSignal, _b: AbortSignal) => 1, { signalAt: 1 })(
      first.signal,
      second.signal,
    )

    expect(seen).toBe(second.signal)
  })

  it('hands the arguments through untouched when no layer changes the signal', async () => {
    const caller = new AbortController()
    let received: unknown[] | undefined
    const args = ['42', caller.signal] as const

    await decorate(recorder([], 'a'), async (...got: unknown[]) => {
      received = got
      return 1
    })(...args)

    expect(received).toEqual(['42', caller.signal])
  })

  it('delivers a synchronous throw from the function as a rejection', async () => {
    const boom = new Error('boom')
    const guarded = decorate(recorder([], 'a'), (() => {
      throw boom
    }) as () => Promise<never>)

    await expect(guarded()).rejects.toBe(boom)
  })

  it.each([
    [null, 'Cannot decorate: the policy is neither a function nor an object with a wrap() method'],
    [{ wrap: 1 }, 'Cannot decorate: the policy is neither a function nor an object with a wrap() method'],
  ])('throws ErrInvalidOption for a policy that is %o', (policy, message) => {
    expect(() => decorate(policy as never, async () => 1)).toThrow(message)
  })

  it('throws ErrInvalidOption for a function that is not one', () => {
    expect(() => decorate(recorder([], 'a'), 'nope' as never)).toThrow(
      'Cannot decorate: fn must be a function, got string',
    )
  })

  it.each([-1, 1.5, Number.NaN])('throws ErrInvalidOption for a signalAt of %s', at => {
    expect(() => decorate(recorder([], 'a'), async () => 1, { signalAt: at })).toThrow(
      `Cannot decorate: signalAt must be an integer of at least 0, got ${String(at)}`,
    )
  })
})

describe('with the built-in policies', () => {
  const alwaysFail = async (): Promise<never> => {
    throw new Error('down')
  }

  // Retry around the breaker lets the breaker see every attempt; the other way round it sees one call per sequence.
  it('counts each attempt in the breaker when the retry is outside it, and one call when it is inside', async () => {
    const outside = circuitBreaker({ name: 'outside', minimumNumberOfCalls: 100 })
    const inside = circuitBreaker({ name: 'inside', minimumNumberOfCalls: 100 })
    const retries = retry({ name: 'inventory', maxAttempts: 3, backoff: 0 })

    await run(compose(retries, outside)(alwaysFail)).catch(() => undefined)
    await run(compose(inside, retries)(alwaysFail)).catch(() => undefined)

    expect(outside.metrics().bufferedCalls).toBe(3)
    expect(inside.metrics().bufferedCalls).toBe(1)
  })

  it('fails fast through a retry when the breaker is open', async () => {
    const breaker = circuitBreaker({ name: 'inventory' })
    const retries = retry({ name: 'inventory', backoff: 60_000 })
    breaker.forceOpen()

    await expect(run(compose(retries, breaker)(async () => 'ok'))).rejects.toBeInstanceOf(ErrCallNotPermitted)
    expect(retries.metrics().failedCallsWithoutRetry).toBe(1)
  })

  // Node keeps 10 frames by default. Every frame the chain puts between the caller and the operation is one of the
  // caller's that an error thrown synchronously in the operation loses.
  it('adds one frame per built-in plus one, n + 1, between the caller and a synchronously throwing operation', async () => {
    const errorClass = Error as { stackTraceLimit?: number }
    const original = errorClass.stackTraceLimit
    errorClass.stackTraceLimit = 50
    try {
      function throwsSynchronously(): never {
        throw new Error('sync')
      }
      const operationThatThrows = sync(throwsSynchronously)
      const breaker = circuitBreaker({ name: 'inventory' })
      const retries = retry({ name: 'inventory', maxAttempts: 1 })
      const breakerOnly = compose(breaker)(operationThatThrows)
      const retryAndBreaker = compose(retries, breaker)(operationThatThrows)
      const decorated = decorate(compose(retries, breaker), operationThatThrows as unknown as () => Promise<never>)
      function callsTheBreaker(): Promise<unknown> {
        return breakerOnly({ signal: undefined }, undefined)
      }
      function callsRetryAndBreaker(): Promise<unknown> {
        return retryAndBreaker({ signal: undefined }, undefined)
      }
      function callsDecorated(): Promise<unknown> {
        return decorated()
      }
      const framesBelow = async (caller: () => Promise<unknown>): Promise<number | undefined> => {
        const error = (await caller().catch((reason: unknown) => reason)) as Error
        const lines = error.stack?.split('\n') ?? []
        const operation = lines.findIndex(line => line.includes('throwsSynchronously'))
        const entry = lines.findIndex(line => line.includes(caller.name))
        return operation > 0 && entry > operation ? entry - operation - 1 : undefined
      }

      expect(await framesBelow(callsTheBreaker)).toBe(2)
      expect(await framesBelow(callsRetryAndBreaker)).toBe(3)
      // decorate() adds its entry, where it reads the caller's signal.
      expect(await framesBelow(callsDecorated)).toBe(4)
    } finally {
      errorClass.stackTraceLimit = original
    }
  })
})
