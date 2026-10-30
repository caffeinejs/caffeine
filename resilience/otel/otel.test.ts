import { Millisecond, Second } from '@caffeinejs/std/duration'
import { diag, DiagLogLevel, metrics, type DiagLogger, type MeterProvider } from '@opentelemetry/api'
import { DataPointType, type Histogram } from '@opentelemetry/sdk-metrics'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { bulkhead } from '../bulkhead/bulkhead.js'
import { circuitBreaker, type CircuitBreaker, type CircuitBreakerOptions } from '../circuitbreaker/circuitbreaker.js'
import { runWith } from '../compose.js'
import { useFakeClock } from '../fake_clock.testkit.js'
import { fallback } from '../fallback/fallback.js'
import { rateLimiter } from '../ratelimiter/ratelimiter.js'
import { retry } from '../retry/retry.js'
import { timeLimiter } from '../timelimiter/timelimiter.js'
import {
  instrumentBulkhead,
  instrumentCircuitBreaker,
  instrumentFallback,
  instrumentRateLimiter,
  instrumentRetry,
  instrumentTimeLimiter,
} from './otel.js'
import { metricsHarness, type MetricsHarness } from './otel.testkit.js'

const cleanups: Array<() => unknown> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function harness(): MetricsHarness {
  const h = metricsHarness()
  cleanups.push(() => h.shutdown())
  return h
}

function breakerOf(options: Partial<CircuitBreakerOptions> = {}): CircuitBreaker {
  return circuitBreaker({
    name: 'inventory',
    slidingWindow: { type: 'count', size: 4 },
    minimumNumberOfCalls: 4,
    permittedNumberOfCallsInHalfOpenState: 1,
    ...options,
  })
}

function succeed(breaker: CircuitBreaker): Promise<unknown> {
  return runWith(() => 'ok', breaker).catch(() => undefined)
}

function fail(breaker: CircuitBreaker, error: unknown = new Error('down')): Promise<unknown> {
  return runWith(() => {
    throw error
  }, breaker).catch(() => undefined)
}

const NAME = { 'resilience.circuit_breaker.name': 'inventory' }

describe('instrumentCircuitBreaker', () => {
  // Scope is how a backend tells this library's series apart from the application's own.
  it('records every instrument under the @caffeinejs/resilience scope', async () => {
    const h = harness()
    const breaker = breakerOf()
    instrumentCircuitBreaker(breaker, { meterProvider: h.meterProvider })

    await succeed(breaker)
    const { scopeMetrics } = await h.collect()

    expect(scopeMetrics.map(scope => scope.scope.name)).toEqual(['@caffeinejs/resilience'])
  })

  it('declares each instrument with the unit and point kind OpenTelemetry expects', async () => {
    const h = harness()
    const breaker = breakerOf()
    instrumentCircuitBreaker(breaker, { meterProvider: h.meterProvider })

    await succeed(breaker)
    await succeed(breaker)
    await fail(breaker)
    await succeed(breaker)

    const expected: Array<[string, string, DataPointType, boolean | undefined]> = [
      ['resilience.circuit_breaker.call.duration', 's', DataPointType.HISTOGRAM, undefined],
      ['resilience.circuit_breaker.not_permitted_calls', '{call}', DataPointType.SUM, true],
      ['resilience.circuit_breaker.state', '1', DataPointType.SUM, false],
      ['resilience.circuit_breaker.buffered_calls', '{call}', DataPointType.SUM, false],
      ['resilience.circuit_breaker.slow_calls', '{call}', DataPointType.SUM, false],
      ['resilience.circuit_breaker.failure_rate', '1', DataPointType.GAUGE, undefined],
      ['resilience.circuit_breaker.slow_call_rate', '1', DataPointType.GAUGE, undefined],
    ]
    for (const [name, unit, type, monotonic] of expected) {
      const metric = await h.metric(name)
      expect(metric, name).toBeDefined()
      expect(metric!.descriptor.unit, name).toBe(unit)
      expect(metric!.descriptor.description.length, name).toBeGreaterThan(0)
      expect(metric!.dataPointType, name).toBe(type)
      if (metric!.dataPointType === DataPointType.SUM) {
        expect(metric!.isMonotonic, name).toBe(monotonic)
      }
    }
  })

  // Dashboards built on seconds read a millisecond value as a thousand times too slow.
  it('records call durations in seconds, bucketed by the advised boundaries', async () => {
    useFakeClock({ toFake: ['performance'] })
    const h = harness()
    const breaker = breakerOf()
    instrumentCircuitBreaker(breaker, { meterProvider: h.meterProvider })

    await runWith(() => {
      vi.advanceTimersByTime(250)
      return 'ok'
    }, breaker)

    const [point] = await h.points('resilience.circuit_breaker.call.duration')
    const histogram = point.value as Histogram
    expect(histogram.count).toBe(1)
    expect(histogram.sum).toBe(0.25)
    expect(histogram.buckets.boundaries).toEqual([
      0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 30, 60,
    ])
  })

  it('splits call durations by kind, adding error.type to failures only', async () => {
    const h = harness()
    const breaker = breakerOf({
      recordResult: result => result === 'unavailable',
      ignoreError: error => error instanceof RangeError,
    })
    instrumentCircuitBreaker(breaker, { meterProvider: h.meterProvider })

    await succeed(breaker)
    await fail(breaker, new TypeError('bad gateway'))
    await runWith(() => 'unavailable', breaker)
    await fail(breaker, new RangeError('caller bug'))

    const attributes = (await h.points('resilience.circuit_breaker.call.duration')).map(point => point.attributes)
    expect(attributes).toEqual(
      expect.arrayContaining([
        { ...NAME, 'resilience.circuit_breaker.kind': 'successful' },
        { ...NAME, 'resilience.circuit_breaker.kind': 'failed', 'error.type': 'TypeError' },
        { ...NAME, 'resilience.circuit_breaker.kind': 'failed', 'error.type': '_OTHER' },
        { ...NAME, 'resilience.circuit_breaker.kind': 'ignored' },
      ]),
    )
    expect(attributes).toHaveLength(4)
  })

  // One series per state, set to 1 for the current one, sums to 1 and graphs as a state timeline.
  it('reports the current state as 1 and every other state as 0', async () => {
    const h = harness()
    const breaker = breakerOf()
    instrumentCircuitBreaker(breaker, { meterProvider: h.meterProvider })

    for (let i = 0; i < 4; i++) {
      await fail(breaker)
    }
    const open = await h.points('resilience.circuit_breaker.state')
    breaker.forceOpen()
    const forced = await h.points('resilience.circuit_breaker.state')

    const valueOf = (points: typeof open, state: string): unknown =>
      points.find(point => point.attributes['resilience.circuit_breaker.state'] === state)?.value
    expect(open).toHaveLength(6)
    expect(valueOf(open, 'open')).toBe(1)
    expect(open.reduce((sum, point) => sum + (point.value as number), 0)).toBe(1)
    expect(valueOf(forced, 'forced_open')).toBe(1)
    expect(valueOf(forced, 'open')).toBe(0)
  })

  it('reports the window by kind and the rates as ratios, leaving rates out below the minimum number of calls', async () => {
    const h = harness()
    const breaker = breakerOf()
    instrumentCircuitBreaker(breaker, { meterProvider: h.meterProvider })

    await succeed(breaker)
    await succeed(breaker)
    await fail(breaker)
    expect(await h.points('resilience.circuit_breaker.buffered_calls')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ attributes: { ...NAME, 'resilience.circuit_breaker.kind': 'successful' }, value: 2 }),
        expect.objectContaining({ attributes: { ...NAME, 'resilience.circuit_breaker.kind': 'failed' }, value: 1 }),
      ]),
    )
    expect(await h.points('resilience.circuit_breaker.failure_rate')).toEqual([])

    await succeed(breaker)
    expect(await h.points('resilience.circuit_breaker.failure_rate')).toEqual([
      expect.objectContaining({ attributes: NAME, value: 0.25 }),
    ])
    expect(await h.points('resilience.circuit_breaker.slow_call_rate')).toEqual([
      expect.objectContaining({ attributes: NAME, value: 0 }),
    ])
  })

  // Series exported while nothing calls the dependency must describe the window as it is now.
  it('reports an empty window once an idle gap outlasts a time window', async () => {
    useFakeClock({ toFake: ['performance'] })
    const h = harness()
    const breaker = breakerOf({ slidingWindow: { type: 'time', duration: 2 * Second } })
    instrumentCircuitBreaker(breaker, { meterProvider: h.meterProvider })
    const window = async (): Promise<unknown[]> =>
      (await h.points('resilience.circuit_breaker.buffered_calls')).map(point => [
        point.attributes['resilience.circuit_breaker.kind'],
        point.value,
      ])
    await succeed(breaker)
    await succeed(breaker)
    await fail(breaker)
    expect(await window()).toEqual(
      expect.arrayContaining([
        ['successful', 2],
        ['failed', 1],
      ]),
    )

    vi.advanceTimersByTime(5_000)

    expect(await window()).toEqual(
      expect.arrayContaining([
        ['successful', 0],
        ['failed', 0],
      ]),
    )
  })

  // A counter that went down would read as a process restart and corrupt every rate computed from it.
  it('keeps the refused-calls counter across reset', async () => {
    const h = harness()
    const breaker = breakerOf()
    instrumentCircuitBreaker(breaker, { meterProvider: h.meterProvider })

    for (let i = 0; i < 4; i++) {
      await fail(breaker)
    }
    await succeed(breaker)
    await succeed(breaker)
    breaker.reset()

    expect(await h.points('resilience.circuit_breaker.not_permitted_calls')).toEqual([
      expect.objectContaining({ attributes: NAME, value: 2 }),
    ])
  })

  it('uses the global MeterProvider when none is given', async () => {
    const h = harness()
    metrics.setGlobalMeterProvider(h.meterProvider)
    cleanups.push(() => metrics.disable())
    const breaker = breakerOf()
    instrumentCircuitBreaker(breaker)

    await succeed(breaker)

    expect(await h.points('resilience.circuit_breaker.call.duration')).toHaveLength(1)
  })

  // A broken exporter or instrument must cost the application its metrics, never its calls.
  it('reports a failing instrument to diag and still completes the call', async () => {
    const logged: unknown[][] = []
    const logger = { error: (...args: unknown[]) => logged.push(args) } as unknown as DiagLogger
    diag.setLogger(logger, DiagLogLevel.ERROR)
    cleanups.push(() => diag.disable())
    let collect: ((result: unknown) => void) | undefined
    const broken = (): never => {
      throw new Error('instrument bug')
    }
    const meterProvider = {
      getMeter: () => ({
        createHistogram: () => ({ record: broken }),
        createObservableCounter: () => ({}),
        createObservableUpDownCounter: () => ({}),
        createObservableGauge: () => ({}),
        addBatchObservableCallback: (callback: (result: unknown) => void) => {
          collect = callback
        },
        removeBatchObservableCallback: () => undefined,
      }),
    } as unknown as MeterProvider
    const breaker = breakerOf()
    instrumentCircuitBreaker(breaker, { meterProvider })

    await expect(runWith(() => 'ok', breaker)).resolves.toBe('ok')
    expect(() => collect!({ observe: broken })).not.toThrow()

    expect(logged.map(([message]) => message)).toEqual([
      '@caffeinejs/resilience instrumentation failed on "success"',
      '@caffeinejs/resilience instrumentation failed on "collect"',
    ])
  })

  it('stops recording and observing once stopped', async () => {
    const h = harness()
    const breaker = breakerOf()
    const stop = instrumentCircuitBreaker(breaker, { meterProvider: h.meterProvider })
    for (let i = 0; i < 4; i++) {
      await fail(breaker)
    }
    await succeed(breaker)

    stop()
    await succeed(breaker)
    await succeed(breaker)
    breaker.reset()
    await succeed(breaker)

    const [duration] = await h.points('resilience.circuit_breaker.call.duration')
    expect((duration.value as Histogram).count).toBe(4)
    for (const point of await h.points('resilience.circuit_breaker.not_permitted_calls')) {
      expect(point.value).toBeLessThanOrEqual(1)
    }
  })
})

describe('instrumentRetry', () => {
  it('counts each call once, by kind, as a monotonic counter', async () => {
    const h = harness()
    const retries = retry({ name: 'inventory', backoff: 0, retryOn: error => !(error instanceof TypeError) })
    instrumentRetry(retries, { meterProvider: h.meterProvider })
    let attempts = 0

    await runWith(() => 'ok', retries)
    await runWith(() => {
      attempts++
      if (attempts === 1) {
        throw new Error('once')
      }
      return 'ok'
    }, retries)
    await runWith(() => {
      throw new TypeError('bad input')
    }, retries).catch(() => undefined)
    await runWith(() => {
      throw new Error('down')
    }, retries).catch(() => undefined)

    const metric = await h.metric('resilience.retry.calls')
    expect(metric?.descriptor.unit).toBe('{call}')
    expect(metric?.dataPointType).toBe(DataPointType.SUM)
    expect(metric?.dataPointType === DataPointType.SUM && metric.isMonotonic).toBe(true)
    const byKind = Object.fromEntries(
      (metric?.dataPoints ?? []).map(point => [point.attributes['resilience.retry.kind'], point.value]),
    )
    expect(byKind).toEqual({
      successful_without_retry: 1,
      successful_with_retry: 1,
      failed_without_retry: 1,
      failed_with_retry: 1,
    })
    expect(metric?.dataPoints.every(point => point.attributes['resilience.retry.name'] === 'inventory')).toBe(true)
  })

  it('stops observing once stopped', async () => {
    const h = harness()
    const retries = retry({ name: 'inventory' })
    const stop = instrumentRetry(retries, { meterProvider: h.meterProvider })
    await runWith(() => 'ok', retries)

    stop()
    await runWith(() => 'ok', retries)

    for (const point of await h.points('resilience.retry.calls')) {
      expect(point.value).toBeLessThanOrEqual(1)
    }
  })
})

// A point's value, by the attributes that tell it apart.
async function valuesBy(h: MetricsHarness, metric: string, attribute: string): Promise<Record<string, unknown>> {
  return Object.fromEntries((await h.points(metric)).map(point => [String(point.attributes[attribute]), point.value]))
}

describe('instrumentTimeLimiter', () => {
  it('counts each call once, by kind, as a monotonic counter', async () => {
    useFakeClock()
    const h = harness()
    const limiter = timeLimiter({ name: 'inventory', timeoutDuration: 100 * Millisecond })
    instrumentTimeLimiter(limiter, { meterProvider: h.meterProvider })

    await runWith(() => 'ok', limiter)
    await runWith(() => {
      throw new Error('down')
    }, limiter).catch(() => undefined)
    const hung = runWith(() => new Promise(() => undefined), limiter).catch(() => undefined)
    await vi.advanceTimersByTimeAsync(100)
    await hung
    // The SDK collects on real timers, and the captured clock must stop pointing at the fake one first.
    vi.useRealTimers()
    vi.restoreAllMocks()

    const metric = await h.metric('resilience.time_limiter.calls')
    expect(metric?.descriptor.unit).toBe('{call}')
    expect(metric?.dataPointType === DataPointType.SUM && metric.isMonotonic).toBe(true)
    expect(await valuesBy(h, 'resilience.time_limiter.calls', 'resilience.time_limiter.kind')).toEqual({
      successful: 1,
      failed: 1,
      timeout: 1,
    })
    expect(metric?.dataPoints.every(point => point.attributes['resilience.time_limiter.name'] === 'inventory')).toBe(
      true,
    )
  })

  it('stops observing once stopped', async () => {
    const h = harness()
    const limiter = timeLimiter({ name: 'inventory', timeoutDuration: 1 * Second })
    const stop = instrumentTimeLimiter(limiter, { meterProvider: h.meterProvider })

    stop()
    await runWith(() => 'ok', limiter)

    expect(await h.points('resilience.time_limiter.calls')).toEqual([])
  })
})

describe('instrumentBulkhead', () => {
  it('reports the slots, the line and the refusals', async () => {
    const h = harness()
    const pool = bulkhead({ name: 'payments', maxConcurrentCalls: 2, maxWaitDuration: 1 * Second, maxQueuedCalls: 1 })
    instrumentBulkhead(pool, { meterProvider: h.meterProvider })
    const holds: Array<() => void> = []
    const hold = () => runWith(() => new Promise<void>(resolve => holds.push(resolve)), pool)

    const running = [hold(), hold(), hold()]
    await runWith(() => 'ok', pool).catch(() => undefined)

    const name = { 'resilience.bulkhead.name': 'payments' }
    expect(await h.points('resilience.bulkhead.available_concurrent_calls')).toEqual([
      expect.objectContaining({ attributes: name, value: 0 }),
    ])
    expect(await h.points('resilience.bulkhead.max_allowed_concurrent_calls')).toEqual([
      expect.objectContaining({ attributes: name, value: 2 }),
    ])
    expect(await h.points('resilience.bulkhead.queued_calls')).toEqual([
      expect.objectContaining({ attributes: name, value: 1 }),
    ])
    expect(await h.points('resilience.bulkhead.rejected_calls')).toEqual([
      expect.objectContaining({ attributes: name, value: 1 }),
    ])
    const rejected = await h.metric('resilience.bulkhead.rejected_calls')
    expect(rejected?.dataPointType === DataPointType.SUM && rejected.isMonotonic).toBe(true)

    for (const release of holds) {
      release()
    }
    await Promise.all(running.slice(0, 2))
    holds[2]?.()
    await running[2]
  })

  it('stops observing once stopped', async () => {
    const h = harness()
    const pool = bulkhead({ name: 'payments' })
    const stop = instrumentBulkhead(pool, { meterProvider: h.meterProvider })

    stop()

    expect(await h.points('resilience.bulkhead.available_concurrent_calls')).toEqual([])
  })
})

describe('instrumentRateLimiter', () => {
  it('reports the permits left, the calls waiting and the refusals', async () => {
    // A frozen clock keeps the period from turning while the SDK collects on real timers.
    useFakeClock({ toFake: ['performance'] })
    const h = harness()
    const quota = rateLimiter({
      name: 'partner-api',
      limitForPeriod: 1,
      limitRefreshPeriod: 1 * Second,
      maxWaitDuration: 1 * Second,
    })
    instrumentRateLimiter(quota, { meterProvider: h.meterProvider })
    const caller = new AbortController()

    await runWith(() => 'ok', quota)
    const waiting = runWith(() => 'ok', quota, caller.signal).catch(() => undefined)
    const refused = await runWith(() => 'ok', quota).catch((error: unknown) => error)
    const name = { 'resilience.rate_limiter.name': 'partner-api' }

    expect(refused).toBeInstanceOf(Error)
    expect(await h.points('resilience.rate_limiter.available_permissions')).toEqual([
      expect.objectContaining({ attributes: name, value: 0 }),
    ])
    expect(await h.points('resilience.rate_limiter.waiting_calls')).toEqual([
      expect.objectContaining({ attributes: name, value: 1 }),
    ])
    expect(await h.points('resilience.rate_limiter.rejected_calls')).toEqual([
      expect.objectContaining({ attributes: name, value: 1 }),
    ])
    const permissions = await h.metric('resilience.rate_limiter.available_permissions')
    expect(permissions?.descriptor.unit).toBe('{permission}')

    caller.abort()
    await waiting
  })

  it('stops observing once stopped', async () => {
    const h = harness()
    const quota = rateLimiter({ name: 'partner-api', limitForPeriod: 1, limitRefreshPeriod: 1 * Second })
    const stop = instrumentRateLimiter(quota, { meterProvider: h.meterProvider })

    stop()

    expect(await h.points('resilience.rate_limiter.available_permissions')).toEqual([])
  })
})

describe('instrumentFallback', () => {
  it('counts each call once, by kind, as a monotonic counter', async () => {
    const h = harness()
    const stale = fallback({ name: 'inventory', fallbackOn: error => (error as Error).message !== 'bug' })
    instrumentFallback(stale, { meterProvider: h.meterProvider })

    await stale.recover(Promise.resolve('ok'), () => 'cached')
    await stale.recover(Promise.reject(new Error('down')), () => 'cached')
    await stale
      .recover(Promise.reject(new Error('down')), () => {
        throw new Error('cache down')
      })
      .catch(() => undefined)
    await stale.recover(Promise.reject(new Error('bug')), () => 'cached').catch(() => undefined)

    const metric = await h.metric('resilience.fallback.calls')
    expect(metric?.descriptor.unit).toBe('{call}')
    expect(metric?.dataPointType === DataPointType.SUM && metric.isMonotonic).toBe(true)
    expect(await valuesBy(h, 'resilience.fallback.calls', 'resilience.fallback.kind')).toEqual({
      successful: 1,
      recovered: 1,
      failed: 1,
      ignored: 1,
    })
  })

  it('reports a failing collection to diag', async () => {
    const logged: unknown[][] = []
    const logger = { error: (...args: unknown[]) => logged.push(args) } as unknown as DiagLogger
    diag.setLogger(logger, DiagLogLevel.ERROR)
    cleanups.push(() => diag.disable())
    let collect: ((result: unknown) => void) | undefined
    const meterProvider = {
      getMeter: () => ({
        createObservableCounter: () => ({
          addCallback: (callback: (result: unknown) => void) => {
            collect = callback
          },
          removeCallback: () => undefined,
        }),
      }),
    } as unknown as MeterProvider
    instrumentFallback(fallback({ name: 'inventory' }), { meterProvider })

    expect(() =>
      collect!({
        observe: () => {
          throw new Error('instrument bug')
        },
      }),
    ).not.toThrow()
    expect(logged.map(([message]) => message)).toEqual(['@caffeinejs/resilience instrumentation failed on "collect"'])
  })
})
