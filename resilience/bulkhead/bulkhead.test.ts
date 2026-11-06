import { getEventListeners } from 'node:events'

import { Millisecond, Second } from '@caffeinejs/std/duration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakeTimersClock } from '../clock.testkit.js'
import { compose, run } from '../compose.js'
import { ErrCallRefused, ErrInvalidOption } from '../errors.js'
import type { CallContext, Operation } from '../policy.js'
import { timeLimiter } from '../timelimiter/timelimiter.js'
import { unhandledRejections } from '../unhandled.testkit.js'
import { bulkhead, type BulkheadEvents, type BulkheadOptions, ErrBulkheadFull } from './bulkhead.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function bulkheadOf(options: Partial<BulkheadOptions> = {}) {
  return bulkhead({ name: 'payments', maxConcurrentCalls: 2, clock: fakeTimersClock, ...options })
}

// Operations that settle only when the test says so, in the order they started.
function gate() {
  const started: string[] = []
  const settles = new Map<string, { resolve: (value: string) => void; reject: (reason: unknown) => void }>()
  const operation = (id: string) => (_ctx: CallContext) => {
    started.push(id)
    return new Promise<string>((resolve, reject) => settles.set(id, { resolve, reject }))
  }
  return {
    operation,
    started,
    resolve: (id: string) => settles.get(id)!.resolve(id),
    reject: (id: string, reason: unknown) => settles.get(id)!.reject(reason),
  }
}

function listen<K extends keyof BulkheadEvents>(
  target: { on: (type: K, listener: (event: BulkheadEvents[K]) => unknown) => () => void },
  ...types: K[]
): Array<[K, BulkheadEvents[K]]> {
  const seen: Array<[K, BulkheadEvents[K]]> = []
  for (const type of types) {
    target.on(type, event => seen.push([type, event]))
  }
  return seen
}

const outcome = (call: Promise<unknown>) =>
  call.then(
    value => ({ value }),
    (error: unknown) => ({ error }),
  )

describe('bulkhead options', () => {
  it.each([
    [{ maxConcurrentCalls: 0 }, 'maxConcurrentCalls must be an integer of at least 1, got 0'],
    [{ maxConcurrentCalls: 1.5 }, 'maxConcurrentCalls must be an integer of at least 1, got 1.5'],
    [{ maxWaitDuration: -1 }, 'maxWaitDuration must be a finite Duration of at least 0s, got -1ms'],
    [
      { maxWaitDuration: Number.POSITIVE_INFINITY },
      'maxWaitDuration must be a finite Duration of at least 0s, got Infinity',
    ],
    [{ maxQueuedCalls: -1 }, 'maxQueuedCalls must be an integer of at least 0, got -1'],
    [{ captureStackTrace: 'yes' }, 'captureStackTrace must be a boolean, got string'],
  ])('refuses %o when it is created, naming it', (options, reason) => {
    const create = () => bulkhead({ name: 'payments', ...(options as object) })

    expect(create).toThrow(ErrInvalidOption)
    expect(create).toThrow(`Cannot create bulkhead "payments": ${reason}`)
  })

  it('requires a name', () => {
    expect(() => bulkhead({ name: '' })).toThrow('Cannot create bulkhead: name must be a non-empty string')
  })

  it('allows 25 calls at once by default, and refuses the next without waiting', async () => {
    const pool = bulkhead({ name: 'payments' })
    const { operation } = gate()

    const running = Array.from({ length: 25 }, (_, i) => run(pool.wrap(operation(`#${i}`))))
    void running

    await expect(run(pool.wrap(operation('#25')))).rejects.toBeInstanceOf(ErrBulkheadFull)
    expect(pool.metrics()).toEqual({
      availableConcurrentCalls: 0,
      maxAllowedConcurrentCalls: 25,
      queuedCalls: 0,
      rejectedCalls: 1,
    })
  })

  it('exposes its name', () => {
    expect(bulkheadOf().name).toBe('payments')
  })
})

describe('bulkhead', () => {
  // The point of a bulkhead: past its limit, a call is refused before it reaches the slow dependency.
  it('runs up to maxConcurrentCalls at once and refuses the next without running it', async () => {
    const pool = bulkheadOf()
    const { operation, started } = gate()

    void run(pool.wrap(operation('a')))
    void run(pool.wrap(operation('b')))
    const refused = await run(pool.wrap(operation('c'))).catch((error: unknown) => error)

    expect(started).toEqual(['a', 'b'])
    expect(refused).toBeInstanceOf(ErrBulkheadFull)
    // The kind every refusal shares, which retry never retries and an HTTP layer answers with 503.
    expect(refused).toBeInstanceOf(ErrCallRefused)
    expect(refused).toMatchObject({
      bulkhead: 'payments',
      retryAfter: undefined,
      code: 'ERR_BULKHEAD_FULL',
      name: 'ErrBulkheadFull',
      message: expect.stringContaining('Cannot call "payments": bulkhead is full with 2 calls running and 0 queued'),
    })
  })

  // Refusals come in bulk while a dependency is slow; capturing a stack for each costs more than the refusal.
  it('refuses without a stack trace unless told to capture one', async () => {
    const quiet = bulkheadOf({ maxConcurrentCalls: 1 })
    const loud = bulkheadOf({ maxConcurrentCalls: 1, captureStackTrace: true })
    const { operation } = gate()
    void run(quiet.wrap(operation('a')))
    void run(loud.wrap(operation('b')))

    const silent = (await run(quiet.wrap(operation('c'))).catch((error: unknown) => error)) as Error
    const traced = (await run(loud.wrap(operation('d'))).catch((error: unknown) => error)) as Error

    const frames = (error: Error) => error.stack?.split('\n').filter(line => /^\s+at /.test(line)) ?? []
    expect(frames(silent)).toEqual([])
    expect(frames(traced).length).toBeGreaterThan(0)
  })

  it.each([
    ['resolves', (g: ReturnType<typeof gate>) => g.resolve('a')],
    ['rejects', (g: ReturnType<typeof gate>) => g.reject('a', new Error('down'))],
  ])('gives the slot back when a call %s', async (_, settle) => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1 })
    const g = gate()

    const first = outcome(run(pool.wrap(g.operation('a'))))
    settle(g)
    await first

    expect(pool.metrics().availableConcurrentCalls).toBe(1)
    void run(pool.wrap(g.operation('b')))
    expect(g.started).toEqual(['a', 'b'])
  })

  it('gives the slot back when the rest of the chain throws synchronously', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1 })
    const error = new Error('sync')

    const throwing = (() => {
      throw error
    }) as Operation<never>

    await expect(pool.wrap(throwing)({ signal: undefined }, undefined)).rejects.toBe(error)
    expect(pool.metrics().availableConcurrentCalls).toBe(1)
  })

  it('lets waiting calls in first come first served as slots free up', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1, maxWaitDuration: 1 * Second, maxQueuedCalls: 3 })
    const g = gate()

    void run(pool.wrap(g.operation('a')))
    void run(pool.wrap(g.operation('b')))
    void run(pool.wrap(g.operation('c')))
    void run(pool.wrap(g.operation('d')))
    expect(pool.metrics().queuedCalls).toBe(3)

    g.resolve('a')
    await vi.advanceTimersByTimeAsync(0)
    g.resolve('b')
    await vi.advanceTimersByTimeAsync(0)
    g.resolve('c')
    await vi.advanceTimersByTimeAsync(0)

    expect(g.started).toEqual(['a', 'b', 'c', 'd'])
    expect(pool.metrics()).toMatchObject({ availableConcurrentCalls: 0, queuedCalls: 0 })
  })

  // An unbounded line is a memory leak under load: the call past the line's length is refused at once.
  it('refuses a call at once when the line is full', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1, maxWaitDuration: 1 * Second, maxQueuedCalls: 1 })
    const g = gate()
    void run(pool.wrap(g.operation('a')))
    void run(pool.wrap(g.operation('b')))

    const refused = await run(pool.wrap(g.operation('c'))).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(ErrBulkheadFull)
    expect((refused as Error).message).toContain('bulkhead is full with 1 call running and 1 queued')
    expect(pool.metrics()).toMatchObject({ queuedCalls: 1, rejectedCalls: 1 })
  })

  it('refuses a waiting call once its wait runs out, leaving nothing behind', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1, maxWaitDuration: 200 * Millisecond })
    const g = gate()
    void run(pool.wrap(g.operation('a')))
    let result: unknown = 'pending'
    const waiting = run(pool.wrap(g.operation('b'))).catch((error: unknown) => (result = error))

    await vi.advanceTimersByTimeAsync(199)
    expect(result).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await waiting

    expect(result).toBeInstanceOf(ErrBulkheadFull)
    expect((result as Error).message).toContain(
      'Cannot call "payments": no slot freed within 200ms with 1 call running',
    )
    expect(pool.metrics()).toMatchObject({ queuedCalls: 0, rejectedCalls: 1 })
    expect(vi.getTimerCount()).toBe(0)

    g.resolve('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(g.started).toEqual(['a'])
    expect(pool.metrics().availableConcurrentCalls).toBe(1)
  })

  it('takes a waiting call out of line when its signal aborts, and never runs it', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1, maxWaitDuration: 10 * Second })
    const g = gate()
    const caller = new AbortController()
    const reason = new Error('client left')
    void run(pool.wrap(g.operation('a')))

    const waiting = run(pool.wrap(g.operation('b')), caller.signal).catch((error: unknown) => error)
    caller.abort(reason)

    expect(await waiting).toBe(reason)
    expect(pool.metrics()).toMatchObject({ queuedCalls: 0, rejectedCalls: 0 })
    expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)

    g.resolve('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(g.started).toEqual(['a'])
    expect(pool.metrics().availableConcurrentCalls).toBe(1)
  })

  it('rejects at once, queueing nothing, when the caller’s signal has already aborted', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1, maxWaitDuration: 1 * Second })
    const g = gate()
    const caller = new AbortController()
    caller.abort(new Error('gone'))
    void run(pool.wrap(g.operation('a')))

    await expect(pool.wrap(() => Promise.resolve('b'))({ signal: caller.signal }, undefined)).rejects.toThrow('gone')
    expect(pool.metrics().queuedCalls).toBe(0)
  })

  // A slot counts work in flight. A time limiter that gave up on a call cannot make the dependency stop, so the slot
  // stays taken until the operation settles; otherwise the bulkhead would admit more calls than are really running.
  it('keeps the slot of a call an outer time limiter gave up on until the operation settles', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1 })
    const limiter = timeLimiter({ name: 'payments', timeoutDuration: 100 * Millisecond })
    const g = gate()

    const call = run(compose(limiter, pool)(g.operation('a'))).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    await call

    expect(pool.metrics().availableConcurrentCalls).toBe(0)
    await expect(run(compose(limiter, pool)(g.operation('b')))).rejects.toBeInstanceOf(ErrBulkheadFull)

    g.resolve('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(pool.metrics().availableConcurrentCalls).toBe(1)
  })

  it('takes a queued call out of line when an outer time limiter gives up on it', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1, maxWaitDuration: 10 * Second })
    const limiter = timeLimiter({ name: 'payments', timeoutDuration: 100 * Millisecond })
    const g = gate()
    void run(pool.wrap(g.operation('a')))

    const waiting = run(compose(limiter, pool)(g.operation('b'))).catch((error: unknown) => error)
    expect(pool.metrics().queuedCalls).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    await waiting

    expect(pool.metrics().queuedCalls).toBe(0)
    g.resolve('a')
    await vi.advanceTimersByTimeAsync(0)
    expect(g.started).toEqual(['a'])
  })

  // Listeners see a finished state: one that starts another call from `finished` must find the slot free.
  it('gives the slot back before it reports the call finished', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1 })
    const g = gate()
    let reentrant: Promise<unknown> | undefined
    pool.on('finished', () => {
      reentrant ??= outcome(run(pool.wrap(g.operation('b'))))
    })

    const first = run(pool.wrap(g.operation('a')))
    g.resolve('a')
    await first

    expect(g.started).toEqual(['a', 'b'])
    g.resolve('b')
    expect(await reentrant).toEqual({ value: 'b' })
  })

  it('captures a stack trace for a call refused after waiting when told to', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1, maxWaitDuration: 100 * Millisecond, captureStackTrace: true })
    const g = gate()
    void run(pool.wrap(g.operation('a')))

    const waiting = run(pool.wrap(g.operation('b'))).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    const refused = (await waiting) as Error

    expect(refused).toBeInstanceOf(ErrBulkheadFull)
    expect(refused.stack?.split('\n').some(line => /^\s+at /.test(line))).toBe(true)
  })

  it('says the bulkhead was disposed in a refusal that captured a stack trace too', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1, maxWaitDuration: 10 * Second, captureStackTrace: true })
    const g = gate()
    void run(pool.wrap(g.operation('a')))
    const waiting = run(pool.wrap(g.operation('b'))).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(300)

    pool.dispose()

    expect(((await waiting) as Error).message).toContain('bulkhead was disposed while the call waited 300ms for a slot')
  })

  // The limit is process-wide: a refusal that changed it would change the stack of every error that follows.
  it('leaves Error.stackTraceLimit as it found it after a refusal', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1 })
    const g = gate()
    const errorClass = Error as { stackTraceLimit?: number }
    const original = errorClass.stackTraceLimit
    void run(pool.wrap(g.operation('a')))

    await run(pool.wrap(g.operation('b'))).catch(() => undefined)

    expect(errorClass.stackTraceLimit).toBe(original)
  })

  it('reports each call as it gets a slot, is refused, or gives its slot back', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1, maxWaitDuration: 500 * Millisecond, maxQueuedCalls: 1 })
    const seen = listen(pool, 'permitted', 'rejected', 'finished')
    const g = gate()

    void run(pool.wrap(g.operation('a')))
    const b = run(pool.wrap(g.operation('b')))
    await run(pool.wrap(g.operation('c'))).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(300)
    g.resolve('a')
    await vi.advanceTimersByTimeAsync(0)
    g.resolve('b')
    await b

    expect(seen).toEqual([
      ['permitted', { name: 'payments', waited: 0 }],
      ['rejected', { name: 'payments' }],
      ['finished', { name: 'payments', duration: 300 }],
      ['permitted', { name: 'payments', waited: 300 }],
      ['finished', { name: 'payments', duration: 0 }],
    ])
  })

  // Node keeps 10 frames by default: every frame between the caller and the operation is one the caller's stack loses.
  it('adds two frames, its own and the lift, between the caller and a synchronously throwing operation', async () => {
    const errorClass = Error as { stackTraceLimit?: number }
    const original = errorClass.stackTraceLimit
    errorClass.stackTraceLimit = 50
    try {
      function operationThatThrows(): never {
        throw new Error('sync')
      }
      const pooled = bulkheadOf().wrap(operationThatThrows as () => Promise<never>)
      function callsTheBulkhead(): Promise<unknown> {
        return pooled({ signal: undefined }, undefined)
      }

      const error = (await callsTheBulkhead().catch((reason: unknown) => reason)) as Error
      const lines = error.stack?.split('\n') ?? []
      const operation = lines.findIndex(line => line.includes('operationThatThrows'))
      const entry = lines.findIndex(line => line.includes('callsTheBulkhead'))

      expect(operation).toBeGreaterThan(0)
      expect(entry - operation - 1).toBe(2)
    } finally {
      errorClass.stackTraceLimit = original
    }
  })
})

describe('bulkhead, dispose', () => {
  // A shutdown must not wait for slots that free up only when running calls end.
  it('refuses every waiting call at once, leaving no timer, while the running calls keep their slots', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1, maxWaitDuration: 10 * Second, maxQueuedCalls: 2 })
    const g = gate()
    const running = run(pool.wrap(g.operation('a')))
    const waiting = ['b', 'c'].map(id => run(pool.wrap(g.operation(id))).catch((error: unknown) => error))
    await vi.advanceTimersByTimeAsync(300)

    pool.dispose()

    for (const refused of await Promise.all(waiting)) {
      expect(refused).toBeInstanceOf(ErrBulkheadFull)
      // Disposal, not a wait that ran out: a reader must not go looking for a 300ms limit nobody set.
      expect((refused as Error).message).toContain(
        'Cannot call "payments": bulkhead was disposed while the call waited 300ms for a slot',
      )
    }
    expect(vi.getTimerCount()).toBe(0)
    expect(pool.metrics()).toMatchObject({ availableConcurrentCalls: 0, queuedCalls: 0, rejectedCalls: 2 })
    g.resolve('a')
    await expect(running).resolves.toBe('a')
    expect(g.started).toEqual(['a'])
    expect(pool.metrics().availableConcurrentCalls).toBe(1)
  })

  // A listener that reads the bulkhead while the shutdown refuses must see the shutdown done, not half of it.
  it('refuses the waiting calls only once none is left in line', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1, maxWaitDuration: 10 * Second, maxQueuedCalls: 2 })
    const g = gate()
    const running = run(pool.wrap(g.operation('a')))
    const waiting = ['b', 'c'].map(id => run(pool.wrap(g.operation(id))).catch((error: unknown) => error))
    const seen: number[] = []
    pool.on('rejected', () => seen.push(pool.metrics().queuedCalls))

    pool.dispose()

    await Promise.all(waiting)
    expect(seen).toEqual([0, 0])
    g.resolve('a')
    await running
  })

  it('still starts a call that finds a free slot, and refuses at once one that would wait', async () => {
    const pool = bulkheadOf({ maxConcurrentCalls: 1, maxWaitDuration: 10 * Second })
    const g = gate()
    pool.dispose()

    const running = run(pool.wrap(g.operation('a')))
    const refused = await run(pool.wrap(g.operation('b'))).catch((error: unknown) => error)

    expect(refused).toBeInstanceOf(ErrBulkheadFull)
    expect(pool.metrics().queuedCalls).toBe(0)
    g.resolve('a')
    await expect(running).resolves.toBe('a')
  })

  it('is what a using declaration calls at the end of its block', async () => {
    const g = gate()
    let waiting: Promise<unknown> | undefined
    {
      using pool = bulkheadOf({ maxConcurrentCalls: 1, maxWaitDuration: 10 * Second })
      void run(pool.wrap(g.operation('a')))
      waiting = run(pool.wrap(g.operation('b'))).catch((error: unknown) => error)
    }

    expect(await waiting).toBeInstanceOf(ErrBulkheadFull)
  })
})

describe('bulkhead, unhandled rejections', () => {
  // Every way a call can end must settle the caller's promise and leave no other one rejected behind it.
  it('leaves no rejection unhandled, whichever way a call ends', async () => {
    const reasons = await unhandledRejections(async () => {
      const pool = bulkheadOf({ maxConcurrentCalls: 1, maxWaitDuration: 100 * Millisecond, maxQueuedCalls: 3 })
      const disposed = bulkheadOf({ maxConcurrentCalls: 1, maxWaitDuration: 10 * Second })
      const g = gate()
      const caller = new AbortController()
      const calls = [
        run(pool.wrap(g.operation('failing'))),
        run(pool.wrap(g.operation('timed out'))),
        run(pool.wrap(g.operation('aborted')), caller.signal),
        run(pool.wrap(g.operation('waiting'))),
        run(pool.wrap(g.operation('refused'))),
        run(disposed.wrap(g.operation('held'))),
        run(disposed.wrap(g.operation('disposed'))),
      ].map(call => call.catch(() => undefined))
      caller.abort()
      await vi.advanceTimersByTimeAsync(100)
      g.reject('failing', new Error('down'))
      disposed.dispose()
      g.reject('held', new Error('down'))
      await Promise.all(calls)
    })

    expect(reasons).toEqual([])
  })
})
