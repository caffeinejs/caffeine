import { Second } from '@caffeinejs/std/duration'
import {
  diag,
  metrics,
  type Attributes,
  type BatchObservableResult,
  type MeterProvider,
  type ObservableResult,
} from '@opentelemetry/api'

import type { Bulkhead } from '../bulkhead/bulkhead.js'
import { CIRCUIT_BREAKER_STATES, type CircuitBreaker } from '../circuitbreaker/circuitbreaker.js'
import type { Fallback } from '../fallback/fallback.js'
import type { RateLimiter } from '../ratelimiter/ratelimiter.js'
import type { Retry } from '../retry/retry.js'
import type { TimeLimiter } from '../timelimiter/timelimiter.js'
import { errorType } from './_error_type.js'

const SCOPE = '@caffeinejs/resilience'

// The semantic-convention HTTP duration buckets, extended to the breaker's default 60 s slow-call threshold.
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 30, 60]

export interface ResilienceInstrumentationOptions {
  /** Defaults to the global provider, `metrics.getMeterProvider()`. */
  meterProvider?: MeterProvider
}

// A failing instrument must never reach the call it measures.
function guarded<A extends unknown[]>(what: string, fn: (...args: A) => void): (...args: A) => void {
  return (...args) => {
    try {
      fn(...args)
    } catch (error) {
      diag.error(`@caffeinejs/resilience instrumentation failed on "${what}"`, error)
    }
  }
}

/**
 * Records OpenTelemetry metrics for one circuit breaker. Returns the function that stops it.
 *
 * `resilience.circuit_breaker.call.duration` (histogram, seconds, by `resilience.circuit_breaker.kind`, with
 * `error.type` on failures), `resilience.circuit_breaker.not_permitted_calls` (counter),
 * `resilience.circuit_breaker.state` (1 for the current state, 0 for the others),
 * `resilience.circuit_breaker.buffered_calls` and `resilience.circuit_breaker.slow_calls` (by kind), and
 * `resilience.circuit_breaker.failure_rate` and `resilience.circuit_breaker.slow_call_rate` (0 to 1, absent below
 * the minimum number of calls). Every series carries `resilience.circuit_breaker.name`.
 *
 * Calling it twice for one breaker records everything twice. A failure inside the instrumentation is reported to
 * `diag.error` and never reaches the call.
 */
export function instrumentCircuitBreaker(
  breaker: CircuitBreaker,
  options: ResilienceInstrumentationOptions = {},
): () => void {
  const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(SCOPE)

  const duration = meter.createHistogram('resilience.circuit_breaker.call.duration', {
    unit: 's',
    description: 'Duration of calls through the circuit breaker, by outcome',
    advice: { explicitBucketBoundaries: DURATION_BUCKETS },
  })
  const notPermitted = meter.createObservableCounter('resilience.circuit_breaker.not_permitted_calls', {
    unit: '{call}',
    description: 'Calls the circuit breaker refused',
  })
  const state = meter.createObservableUpDownCounter('resilience.circuit_breaker.state', {
    unit: '1',
    description: 'State of the circuit breaker: 1 for the current state, 0 for the others',
  })
  const buffered = meter.createObservableUpDownCounter('resilience.circuit_breaker.buffered_calls', {
    unit: '{call}',
    description: 'Calls in the current sliding window, by outcome',
  })
  const slow = meter.createObservableUpDownCounter('resilience.circuit_breaker.slow_calls', {
    unit: '{call}',
    description: 'Slow calls in the current sliding window, by outcome',
  })
  const failureRate = meter.createObservableGauge('resilience.circuit_breaker.failure_rate', {
    unit: '1',
    description: 'Failure rate of the current sliding window, from 0 to 1',
  })
  const slowCallRate = meter.createObservableGauge('resilience.circuit_breaker.slow_call_rate', {
    unit: '1',
    description: 'Slow call rate of the current sliding window, from 0 to 1',
  })

  const name = { 'resilience.circuit_breaker.name': breaker.name }
  const successful = { ...name, 'resilience.circuit_breaker.kind': 'successful' }
  const failed = { ...name, 'resilience.circuit_breaker.kind': 'failed' }
  const ignored = { ...name, 'resilience.circuit_breaker.kind': 'ignored' }
  const states = CIRCUIT_BREAKER_STATES.map(value => ({ ...name, 'resilience.circuit_breaker.state': value }))

  const unsubscribers = [
    breaker.on(
      'success',
      guarded('success', event => duration.record(event.duration / Second, successful)),
    ),
    breaker.on(
      'failure',
      guarded('failure', event => {
        const attributes: Attributes = { ...failed, 'error.type': 'error' in event ? errorType(event.error) : '_OTHER' }
        duration.record(event.duration / Second, attributes)
      }),
    ),
    breaker.on(
      'ignored',
      guarded('ignored', event => duration.record(event.duration / Second, ignored)),
    ),
  ]

  // One snapshot per collection feeds every observable instrument.
  const observables = [notPermitted, state, buffered, slow, failureRate, slowCallRate]
  const observe = guarded('collect', (result: BatchObservableResult) => {
    const snapshot = breaker.metrics()
    const current = breaker.state

    result.observe(notPermitted, snapshot.notPermittedCalls, name)
    for (let i = 0; i < CIRCUIT_BREAKER_STATES.length; i++) {
      result.observe(state, CIRCUIT_BREAKER_STATES[i] === current ? 1 : 0, states[i])
    }
    result.observe(buffered, snapshot.successfulCalls, successful)
    result.observe(buffered, snapshot.failedCalls, failed)
    result.observe(slow, snapshot.slowSuccessfulCalls, successful)
    result.observe(slow, snapshot.slowFailedCalls, failed)
    if (snapshot.failureRate !== undefined) {
      result.observe(failureRate, snapshot.failureRate / 100, name)
    }
    if (snapshot.slowCallRate !== undefined) {
      result.observe(slowCallRate, snapshot.slowCallRate / 100, name)
    }
  })
  meter.addBatchObservableCallback(observe, observables)

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe()
    }
    meter.removeBatchObservableCallback(observe, observables)
  }
}

/**
 * Records OpenTelemetry metrics for one retry. Returns the function that stops it.
 *
 * `resilience.retry.calls` (counter) counts each call once by `resilience.retry.kind`: `successful_without_retry`,
 * `successful_with_retry`, `failed_without_retry` or `failed_with_retry`. Every series carries
 * `resilience.retry.name`.
 *
 * A failure inside the instrumentation is reported to `diag.error` and never reaches the call.
 */
export function instrumentRetry(retries: Retry, options: ResilienceInstrumentationOptions = {}): () => void {
  return instrumentCalls(
    options,
    'resilience.retry.calls',
    'resilience.retry',
    retries.name,
    'Calls through the retry, by outcome',
    () => {
      const snapshot = retries.metrics()
      return {
        successful_without_retry: snapshot.successfulCallsWithoutRetry,
        successful_with_retry: snapshot.successfulCallsWithRetry,
        failed_without_retry: snapshot.failedCallsWithoutRetry,
        failed_with_retry: snapshot.failedCallsWithRetry,
      }
    },
  )
}

// One observable counter of lifetime calls by outcome, for the strategies whose metrics are only counts.
function instrumentCalls(
  options: ResilienceInstrumentationOptions,
  instrument: string,
  attribute: string,
  name: string,
  description: string,
  counts: () => Record<string, number>,
): () => void {
  const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(SCOPE)
  const calls = meter.createObservableCounter(instrument, { unit: '{call}', description })

  const kinds = new Map<string, Attributes>()
  const observe = guarded('collect', (result: ObservableResult) => {
    for (const [kind, value] of Object.entries(counts())) {
      let attributes = kinds.get(kind)
      if (attributes === undefined) {
        attributes = { [`${attribute}.name`]: name, [`${attribute}.kind`]: kind }
        kinds.set(kind, attributes)
      }
      result.observe(value, attributes)
    }
  })
  calls.addCallback(observe)

  return () => {
    calls.removeCallback(observe)
  }
}

/**
 * Records OpenTelemetry metrics for one time limiter. Returns the function that stops it.
 *
 * `resilience.time_limiter.calls` (counter) counts each call once by `resilience.time_limiter.kind`: `successful`,
 * `failed` or `timeout`. A call the caller aborted is in none of them. Every series carries
 * `resilience.time_limiter.name`.
 *
 * A failure inside the instrumentation is reported to `diag.error` and never reaches the call.
 */
export function instrumentTimeLimiter(
  limiter: TimeLimiter,
  options: ResilienceInstrumentationOptions = {},
): () => void {
  return instrumentCalls(
    options,
    'resilience.time_limiter.calls',
    'resilience.time_limiter',
    limiter.name,
    'Calls through the time limiter, by outcome',
    () => {
      const snapshot = limiter.metrics()
      return { successful: snapshot.successfulCalls, failed: snapshot.failedCalls, timeout: snapshot.timedOutCalls }
    },
  )
}

/**
 * Records OpenTelemetry metrics for one fallback. Returns the function that stops it.
 *
 * `resilience.fallback.calls` (counter) counts each call once by `resilience.fallback.kind`: `successful`,
 * `recovered`, `failed` or `ignored`. Every series carries `resilience.fallback.name`.
 *
 * A failure inside the instrumentation is reported to `diag.error` and never reaches the call.
 */
export function instrumentFallback(stale: Fallback, options: ResilienceInstrumentationOptions = {}): () => void {
  return instrumentCalls(
    options,
    'resilience.fallback.calls',
    'resilience.fallback',
    stale.name,
    'Calls through the fallback, by outcome',
    () => {
      const snapshot = stale.metrics()
      return {
        successful: snapshot.successfulCalls,
        recovered: snapshot.recoveredCalls,
        failed: snapshot.failedCalls,
        ignored: snapshot.ignoredCalls,
      }
    },
  )
}

/**
 * Records OpenTelemetry metrics for one bulkhead. Returns the function that stops it.
 *
 * `resilience.bulkhead.available_concurrent_calls`, `resilience.bulkhead.max_allowed_concurrent_calls` and
 * `resilience.bulkhead.queued_calls` (up-down counters), and `resilience.bulkhead.rejected_calls` (counter). Every
 * series carries `resilience.bulkhead.name`.
 *
 * A failure inside the instrumentation is reported to `diag.error` and never reaches the call.
 */
export function instrumentBulkhead(pool: Bulkhead, options: ResilienceInstrumentationOptions = {}): () => void {
  const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(SCOPE)

  const available = meter.createObservableUpDownCounter('resilience.bulkhead.available_concurrent_calls', {
    unit: '{call}',
    description: 'Calls the bulkhead would let start now',
  })
  const allowed = meter.createObservableUpDownCounter('resilience.bulkhead.max_allowed_concurrent_calls', {
    unit: '{call}',
    description: 'Calls the bulkhead lets run at once',
  })
  const queued = meter.createObservableUpDownCounter('resilience.bulkhead.queued_calls', {
    unit: '{call}',
    description: 'Calls waiting for a slot',
  })
  const rejected = meter.createObservableCounter('resilience.bulkhead.rejected_calls', {
    unit: '{call}',
    description: 'Calls the bulkhead refused',
  })

  const name = { 'resilience.bulkhead.name': pool.name }
  const observables = [available, allowed, queued, rejected]
  const observe = guarded('collect', (result: BatchObservableResult) => {
    const snapshot = pool.metrics()
    result.observe(available, snapshot.availableConcurrentCalls, name)
    result.observe(allowed, snapshot.maxAllowedConcurrentCalls, name)
    result.observe(queued, snapshot.queuedCalls, name)
    result.observe(rejected, snapshot.rejectedCalls, name)
  })
  meter.addBatchObservableCallback(observe, observables)

  return () => {
    meter.removeBatchObservableCallback(observe, observables)
  }
}

/**
 * Records OpenTelemetry metrics for one rate limiter. Returns the function that stops it.
 *
 * `resilience.rate_limiter.available_permissions` and `resilience.rate_limiter.waiting_calls` (up-down counters),
 * and `resilience.rate_limiter.rejected_calls` (counter). Every series carries `resilience.rate_limiter.name`.
 *
 * A failure inside the instrumentation is reported to `diag.error` and never reaches the call.
 */
export function instrumentRateLimiter(quota: RateLimiter, options: ResilienceInstrumentationOptions = {}): () => void {
  const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(SCOPE)

  const available = meter.createObservableUpDownCounter('resilience.rate_limiter.available_permissions', {
    unit: '{permission}',
    description: 'Permits left in the current period',
  })
  const waiting = meter.createObservableUpDownCounter('resilience.rate_limiter.waiting_calls', {
    unit: '{call}',
    description: 'Calls waiting for a permit',
  })
  const rejected = meter.createObservableCounter('resilience.rate_limiter.rejected_calls', {
    unit: '{call}',
    description: 'Calls the rate limiter refused',
  })

  const name = { 'resilience.rate_limiter.name': quota.name }
  const observables = [available, waiting, rejected]
  const observe = guarded('collect', (result: BatchObservableResult) => {
    const snapshot = quota.metrics()
    result.observe(available, snapshot.availablePermissions, name)
    result.observe(waiting, snapshot.waitingCalls, name)
    result.observe(rejected, snapshot.rejectedCalls, name)
  })
  meter.addBatchObservableCallback(observe, observables)

  return () => {
    meter.removeBatchObservableCallback(observe, observables)
  }
}
