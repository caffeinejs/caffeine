import {
  diag,
  metrics,
  type Attributes,
  type BatchObservableResult,
  type MeterProvider,
  type ObservableResult,
} from '@opentelemetry/api'

import type { CircuitBreaker, CircuitBreakerState } from '../circuit_breaker/circuit_breaker.js'
import type { Retry } from '../retry/retry.js'
import { errorType } from './_error_type.js'

const SCOPE = '@caffeinejs/resilience'

// The semantic-convention HTTP duration buckets, extended to the breaker's default 60 s slow-call threshold.
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10, 30, 60]

const STATES: readonly CircuitBreakerState[] = [
  'closed',
  'open',
  'half_open',
  'forced_open',
  'disabled',
  'metrics_only',
]

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
  const states = STATES.map(value => ({ ...name, 'resilience.circuit_breaker.state': value }))

  const unsubscribers = [
    breaker.on(
      'success',
      guarded('success', event => duration.record(event.durationMs / 1000, successful)),
    ),
    breaker.on(
      'failure',
      guarded('failure', event => {
        const attributes: Attributes = { ...failed, 'error.type': 'error' in event ? errorType(event.error) : '_OTHER' }
        duration.record(event.durationMs / 1000, attributes)
      }),
    ),
    breaker.on(
      'ignored',
      guarded('ignored', event => duration.record(event.durationMs / 1000, ignored)),
    ),
  ]

  // One snapshot per collection feeds every observable instrument.
  const observables = [notPermitted, state, buffered, slow, failureRate, slowCallRate]
  const observe = guarded('collect', (result: BatchObservableResult) => {
    const snapshot = breaker.metrics()
    const current = breaker.state

    result.observe(notPermitted, snapshot.notPermittedCalls, name)
    for (let i = 0; i < STATES.length; i++) {
      result.observe(state, STATES[i] === current ? 1 : 0, states[i])
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
  const meter = (options.meterProvider ?? metrics.getMeterProvider()).getMeter(SCOPE)

  const calls = meter.createObservableCounter('resilience.retry.calls', {
    unit: '{call}',
    description: 'Calls through the retry, by outcome',
  })

  const name = { 'resilience.retry.name': retries.name }
  const kind = (value: string): Attributes => ({ ...name, 'resilience.retry.kind': value })
  const successfulWithoutRetry = kind('successful_without_retry')
  const successfulWithRetry = kind('successful_with_retry')
  const failedWithoutRetry = kind('failed_without_retry')
  const failedWithRetry = kind('failed_with_retry')

  const observe = guarded('collect', (result: ObservableResult) => {
    const snapshot = retries.metrics()
    result.observe(snapshot.successfulCallsWithoutRetry, successfulWithoutRetry)
    result.observe(snapshot.successfulCallsWithRetry, successfulWithRetry)
    result.observe(snapshot.failedCallsWithoutRetry, failedWithoutRetry)
    result.observe(snapshot.failedCallsWithRetry, failedWithRetry)
  })
  calls.addCallback(observe)

  return () => {
    calls.removeCallback(observe)
  }
}
