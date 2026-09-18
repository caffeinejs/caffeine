import type { Attributes } from '@opentelemetry/api'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricData,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics'

import { circuitBreaker, type CircuitBreaker } from '../circuit_breaker/circuit_breaker.js'
import { runWith } from '../compose.js'
import { retry, type Retry } from '../retry/retry.js'

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
    slowCallDurationThresholdMs: 1,
    slowCallRateThreshold: 100,
  })
  const retries = retry({ name: 'inventory', backoff: 0, retryOn: error => !(error instanceof TypeError) })

  return { breaker, retries }
}

export async function driveBreaker(breaker: CircuitBreaker): Promise<void> {
  const slow = (): Promise<string> => new Promise(resolve => setTimeout(() => resolve('ok'), 5))

  await runWith(slow, breaker)
  await runWith(() => 'ok', breaker)
  for (let i = 0; i < 2; i++) {
    await runWith(() => {
      throw new Error('down')
    }, breaker).catch(() => undefined)
  }
  await runWith(() => 'ok', breaker).catch(() => undefined)
}

export async function driveRetry(retries: Retry): Promise<void> {
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
}
