import { Millisecond } from '@caffeinejs/std/duration'
import { fc, it } from '@fast-check/vitest'
import { afterEach, beforeEach, describe, expect, vi } from 'vitest'

import { fakeTimersClock } from '../clock.testkit.js'
import { run } from '../compose.js'
import {
  circuitBreaker,
  type CircuitBreakerState,
  ErrCallNotPermitted,
  type NotPermittedState,
} from './circuitbreaker.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

class Failed extends Error {}
class Ignored extends Error {}

// How a call ends: `harmless` throws an error recordError does not list, which counts as a success.
type Outcome = 'success' | 'failure' | 'ignored' | 'harmless'

type Command =
  | { readonly kind: 'start'; readonly outcome: Outcome }
  | { readonly kind: 'settle'; readonly pick: number }
  | { readonly kind: 'advance'; readonly ms: number }
  | { readonly kind: 'forceOpen' | 'disable' | 'metricsOnly' | 'reset' | 'dispose' }
  | { readonly kind: 'transitionToHalfOpen' | 'transitionToClosed' }
  | { readonly kind: 'transitionToOpen'; readonly for: number | undefined }

interface Config {
  readonly size: number
  readonly minimum: number
  readonly failureRateThreshold: number
  readonly slowCallRateThreshold: number
  readonly slowMs: number
  readonly waitMs: number
  readonly backoff: boolean
  readonly trials: number
  readonly maxWaitInHalfOpenMs: number
  readonly automatic: boolean
}

interface Recorded {
  readonly failed: boolean
  readonly slow: boolean
}

type Admission =
  | { readonly epoch: number | undefined }
  | { readonly refused: NotPermittedState; readonly retryAfter: number | undefined }

// The breaker as its documentation describes it, written for reading rather than speed: plain arrays for windows,
// one loop for admission, and an epoch, bumped on every state entry, that a call must still hold to be recorded.
class Reference {
  state: CircuitBreakerState = 'closed'
  now = 0
  epoch = 0
  window: Recorded[] = []
  trials: Recorded[] = []
  openedAt = 0
  openWait = 0
  opens = 0
  lastTrialAt = 0
  permits = 0
  notPermitted = 0
  disposed = false
  readonly minimum: number

  constructor(readonly c: Config) {
    this.minimum = Math.min(c.minimum, c.size)
  }

  enter(state: CircuitBreakerState, wait?: number): void {
    if (state === 'open') {
      this.openWait = wait ?? (this.c.backoff ? (this.opens + 1) * this.c.waitMs : this.c.waitMs)
      this.openedAt = this.now
      this.opens++
    } else if (state === 'half_open') {
      this.permits = this.c.trials
      this.trials = []
    } else if (state === 'closed') {
      this.window = []
      this.opens = 0
    }
    this.state = state
    this.epoch++
  }

  admit(): Admission {
    for (;;) {
      switch (this.state) {
        case 'disabled':
          return { epoch: undefined }
        case 'closed':
        case 'metrics_only':
          return { epoch: this.epoch }
        case 'forced_open':
          return this.refuse('forced_open', undefined)
        case 'open': {
          const left = this.openedAt + this.openWait - this.now
          if (left > 0) {
            return this.refuse('open', left)
          }
          this.enter('half_open')
          continue
        }
        case 'half_open':
          if (this.permits > 0) {
            this.permits--
            this.lastTrialAt = this.now
            return { epoch: this.epoch }
          }
          if (this.c.maxWaitInHalfOpenMs > 0 && this.now - this.lastTrialAt >= this.c.maxWaitInHalfOpenMs) {
            this.enter('open')
            continue
          }
          return this.refuse('half_open', undefined)
      }
    }
  }

  refuse(state: NotPermittedState, retryAfter: number | undefined): Admission {
    this.notPermitted++
    return { refused: state, retryAfter }
  }

  settle(epoch: number | undefined, start: number, outcome: Outcome): void {
    if (epoch !== this.epoch) {
      return
    }
    if (outcome === 'ignored') {
      if (this.state === 'half_open') {
        this.permits++
      }
      return
    }

    const call = { failed: outcome === 'failure', slow: this.now - start > this.c.slowMs }
    if (this.state === 'closed' || this.state === 'metrics_only') {
      this.window.push(call)
      if (this.window.length > this.c.size) {
        this.window.shift()
      }
      if (this.state === 'closed' && this.window.length >= this.minimum && this.reached(this.window)) {
        this.enter('open')
      }
    } else if (this.state === 'half_open') {
      this.trials.push(call)
      if (this.trials.length >= this.c.trials) {
        this.enter(this.reached(this.trials) ? 'open' : 'closed')
      }
    }
  }

  advance(ms: number): void {
    this.now += ms
    if (this.c.automatic && !this.disposed && this.state === 'open' && this.now >= this.openedAt + this.openWait) {
      this.enter('half_open')
    }
  }

  reached(calls: readonly Recorded[]): boolean {
    const failed = calls.filter(call => call.failed).length
    const slow = calls.filter(call => call.slow).length
    return (
      failed * 100 >= this.c.failureRateThreshold * calls.length ||
      slow * 100 >= this.c.slowCallRateThreshold * calls.length
    )
  }

  metrics() {
    const halfOpen = this.state === 'half_open'
    const calls = halfOpen ? this.trials : this.window
    const measured = calls.length > 0 && calls.length >= (halfOpen ? this.c.trials : this.minimum)
    const failed = calls.filter(call => call.failed).length
    const slow = calls.filter(call => call.slow).length
    return {
      bufferedCalls: calls.length,
      failedCalls: failed,
      slowCalls: slow,
      failureRate: measured ? (failed / calls.length) * 100 : undefined,
      slowCallRate: measured ? (slow / calls.length) * 100 : undefined,
      notPermittedCalls: this.notPermitted,
    }
  }
}

// Times on a coarse grid and thresholds that small windows meet exactly, so the edges of every comparison come up.
const tick = (min: number, max: number) => fc.integer({ min, max }).map(n => n * 50)
const threshold = fc.oneof(fc.constantFrom(25, 50, 75, 100), fc.integer({ min: 1, max: 100 }))

const config: fc.Arbitrary<Config> = fc.record({
  size: fc.integer({ min: 1, max: 5 }),
  minimum: fc.integer({ min: 1, max: 6 }),
  failureRateThreshold: threshold,
  slowCallRateThreshold: threshold,
  slowMs: tick(1, 4),
  waitMs: tick(0, 8),
  backoff: fc.boolean(),
  trials: fc.integer({ min: 1, max: 3 }),
  maxWaitInHalfOpenMs: tick(0, 6),
  automatic: fc.boolean(),
})

// Mostly calls and time, the schedules where a window or a trial goes wrong, with a manual move now and then.
const command: fc.Arbitrary<Command> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant('start' as const),
      outcome: fc.constantFrom<Outcome>('success', 'failure', 'ignored', 'harmless'),
    }),
    weight: 8,
  },
  { arbitrary: fc.record({ kind: fc.constant('settle' as const), pick: fc.nat() }), weight: 8 },
  { arbitrary: fc.record({ kind: fc.constant('advance' as const), ms: tick(1, 8) }), weight: 6 },
  {
    arbitrary: fc.record({
      kind: fc.constant('transitionToOpen' as const),
      for: fc.option(tick(0, 10), { nil: undefined }),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      kind: fc.constantFrom(
        'forceOpen' as const,
        'disable' as const,
        'metricsOnly' as const,
        'reset' as const,
        'dispose' as const,
        'transitionToHalfOpen' as const,
        'transitionToClosed' as const,
      ),
    }),
    weight: 2,
  },
)

interface Pending {
  readonly outcome: Outcome
  readonly start: number
  readonly epoch: number | undefined
  readonly settle: () => void
  readonly done: Promise<unknown>
}

describe('circuit breaker (property)', () => {
  // Whatever the calls, their timing and the manual moves, the breaker must be in the state its rules name, refuse
  // exactly the calls they refuse, with the wait they name, and count what they count.
  it.prop([config, fc.array(command, { minLength: 1, maxLength: 80, size: 'max' })], { numRuns: 500 })(
    'agrees with a reference model of its rules',
    async (c, commands) => {
      vi.clearAllTimers()
      const breaker = circuitBreaker({
        name: 'inventory',
        slidingWindow: { type: 'count', size: c.size },
        minimumNumberOfCalls: c.minimum,
        failureRateThreshold: c.failureRateThreshold,
        slowCallRateThreshold: c.slowCallRateThreshold,
        slowCallDurationThreshold: c.slowMs * Millisecond,
        waitDurationInOpenState: c.backoff ? openCount => openCount * c.waitMs * Millisecond : c.waitMs * Millisecond,
        permittedNumberOfCallsInHalfOpenState: c.trials,
        maxWaitDurationInHalfOpenState: c.maxWaitInHalfOpenMs * Millisecond,
        automaticTransitionFromOpenToHalfOpen: c.automatic,
        recordError: [Failed],
        ignoreError: [Ignored],
        clock: fakeTimersClock,
      })
      const model = new Reference(c)
      const pending: Pending[] = []

      for (const step of commands) {
        switch (step.kind) {
          case 'start': {
            const admission = model.admit()
            const gate = Promise.withResolvers<string>()
            let started = false
            const done = run(
              breaker.wrap(() => {
                started = true
                return gate.promise
              }),
            ).catch((error: unknown) => error)

            if ('refused' in admission) {
              expect(started).toBe(false)
              const refused = await done
              expect(refused).toBeInstanceOf(ErrCallNotPermitted)
              expect(refused).toMatchObject({ state: admission.refused, retryAfter: admission.retryAfter })
            } else {
              expect(started).toBe(true)
              const settle = (): void => {
                const errors = { failure: Failed, ignored: Ignored, harmless: Error } as const
                if (step.outcome === 'success') {
                  gate.resolve('ok')
                } else {
                  gate.reject(new errors[step.outcome]('down'))
                }
              }
              pending.push({ outcome: step.outcome, start: model.now, epoch: admission.epoch, settle, done })
            }
            break
          }
          case 'settle': {
            if (pending.length === 0) {
              break
            }
            const [call] = pending.splice(step.pick % pending.length, 1)
            call!.settle()
            await call!.done
            model.settle(call!.epoch, call!.start, call!.outcome)
            break
          }
          case 'advance':
            vi.advanceTimersByTime(step.ms)
            model.advance(step.ms)
            break
          case 'transitionToOpen':
            breaker.transitionToOpen(step.for === undefined ? undefined : { for: step.for * Millisecond })
            model.enter('open', step.for)
            break
          case 'transitionToHalfOpen':
            breaker.transitionToHalfOpen()
            model.enter('half_open')
            break
          case 'transitionToClosed':
          case 'reset':
            breaker[step.kind]()
            model.enter('closed')
            break
          case 'dispose':
            breaker.dispose()
            model.disposed = true
            break
          default: {
            const target = ({ forceOpen: 'forced_open', disable: 'disabled', metricsOnly: 'metrics_only' } as const)[
              step.kind
            ]
            breaker[step.kind]()
            if (model.state !== target) {
              model.enter(target)
            }
          }
        }

        expect(breaker.state).toBe(model.state)
        expect(breaker.metrics()).toMatchObject(model.metrics())
      }
    },
  )
})
