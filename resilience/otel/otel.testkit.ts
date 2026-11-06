import type { Attributes } from '@opentelemetry/api'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics'

import { bulkhead, type Bulkhead } from '../bulkhead/bulkhead.js'
import { circuitBreaker, type CircuitBreaker } from '../circuitbreaker/circuitbreaker.js'
import { run } from '../compose.js'
import { fallback, type Fallback } from '../fallback/fallback.js'
import { rateLimiter, type RateLimiter } from '../ratelimiter/ratelimiter.js'
import { retry, type Retry } from '../retry/retry.js'
import { timeLimiter, type TimeLimiter } from '../timelimiter/timelimiter.js'

export interface Point {
  attributes: Attributes
  value: unknown
}

export interface MetricsHarness {
  readonly meterProvider: MeterProvider
  collect(): Promise<ResourceMetrics>
  metric(name: string): Promise<MetricData | undefined>
  points(name: string): Promise<Point[]>
  shutdown(): Promise<void>
}

// A real SDK pipeline, collected on demand.
export function metricsHarness(): MetricsHarness {
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
    exportIntervalMillis: 3_600_000,
  })
  const meterProvider = new MeterProvider({ readers: [reader] })

  const collect = async (): Promise<ResourceMetrics> => (await reader.collect()).resourceMetrics
  const all = async (): Promise<MetricData[]> => (await collect()).scopeMetrics.flatMap(scope => scope.metrics)

  return {
    meterProvider,
    collect,
    metric: async name => (await all()).find(metric => metric.descriptor.name === name),
    points: async name =>
      (await all()).filter(metric => metric.descriptor.name === name).flatMap(metric => metric.dataPoints as Point[]),
    shutdown: () => meterProvider.shutdown(),
  }
}

// A breaker and a retry that `driveBreaker` and `driveRetry` take through every instrument: a full window with a
// slow call, a trip, a refusal, and every retry kind.
export function newStrategies(): { breaker: CircuitBreaker; retries: Retry } {
  const breaker = circuitBreaker({
    name: 'inventory',
    slidingWindow: { type: 'count', size: 4 },
    minimumNumberOfCalls: 4,
    slowCallDurationThreshold: 1,
    slowCallRateThreshold: 100,
  })
  const retries = retry({ name: 'inventory', backoff: 0, retryOn: error => !(error instanceof TypeError) })

  return { breaker, retries }
}

export async function driveBreaker(breaker: CircuitBreaker): Promise<void> {
  const slow = (): Promise<string> => new Promise(resolve => setTimeout(() => resolve('ok'), 5))

  await run(breaker.wrap(slow))
  await run(breaker.wrap(async () => 'ok'))
  for (let i = 0; i < 2; i++) {
    await run(
      breaker.wrap(async () => {
        throw new Error('down')
      }),
    ).catch(() => undefined)
  }
  await run(breaker.wrap(async () => 'ok')).catch(() => undefined)
}

export async function driveRetry(retries: Retry): Promise<void> {
  let attempts = 0
  await run(retries.wrap(async () => 'ok'))
  await run(
    retries.wrap(async () => {
      attempts++
      if (attempts === 1) {
        throw new Error('once')
      }
      return 'ok'
    }),
  )
  await run(
    retries.wrap(async () => {
      throw new TypeError('bad input')
    }),
  ).catch(() => undefined)
  await run(
    retries.wrap(async () => {
      throw new Error('down')
    }),
  ).catch(() => undefined)
}

// One of each newer strategy, sized so `driveOthers` reaches every series each one reports.
export function newOtherStrategies(): { limiter: TimeLimiter; pool: Bulkhead; quota: RateLimiter; stale: Fallback } {
  return {
    limiter: timeLimiter({ name: 'inventory', timeoutDuration: 5 }),
    pool: bulkhead({ name: 'inventory', maxConcurrentCalls: 1 }),
    quota: rateLimiter({ name: 'inventory', limitForPeriod: 1, limitRefreshPeriod: 3_600_000 }),
    stale: fallback(() => 'cached', { name: 'inventory' }),
  }
}

export async function driveOthers({
  limiter,
  pool,
  quota,
  stale,
}: ReturnType<typeof newOtherStrategies>): Promise<void> {
  await run(limiter.wrap(async () => 'ok'))
  await run(limiter.wrap(async () => new Promise(resolve => setTimeout(resolve, 50)))).catch(() => undefined)

  let release!: () => void
  const held = run(pool.wrap(async () => new Promise<void>(resolve => (release = resolve))))
  await run(pool.wrap(async () => 'ok')).catch(() => undefined)
  release()
  await held

  await run(quota.wrap(async () => 'ok'))
  await run(quota.wrap(async () => 'ok')).catch(() => undefined)

  await run(stale.wrap(async () => 'ok'))
  await run(
    stale.wrap(async () => {
      throw new Error('down')
    }),
  )
}
