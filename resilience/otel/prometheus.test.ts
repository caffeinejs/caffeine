import { PrometheusSerializer } from '@opentelemetry/exporter-prometheus'
import { DataPointType } from '@opentelemetry/sdk-metrics'
import { afterEach, describe, expect, it } from 'vitest'

import {
  instrumentBulkhead,
  instrumentCircuitBreaker,
  instrumentFallback,
  instrumentRateLimiter,
  instrumentRetry,
  instrumentTimeLimiter,
} from './otel.js'
import {
  driveBreaker,
  driveOthers,
  driveRetry,
  metricsHarness,
  newOtherStrategies,
  newStrategies,
  type MetricsHarness,
} from './otel.testkit.js'

let h: MetricsHarness | undefined

afterEach(async () => {
  await h?.shutdown()
})

// Most of these metrics end up in Prometheus; the exposition is what dashboards and alerts are written against.
describe('Prometheus exposition', () => {
  it('exposes every instrument under its dotted name with underscores, with the type its kind maps to', async () => {
    h = metricsHarness()
    const { breaker, retries } = newStrategies()
    instrumentCircuitBreaker(breaker, { meterProvider: h.meterProvider })
    instrumentRetry(retries, { meterProvider: h.meterProvider })
    const others = newOtherStrategies()
    instrumentTimeLimiter(others.limiter, { meterProvider: h.meterProvider })
    instrumentBulkhead(others.pool, { meterProvider: h.meterProvider })
    instrumentRateLimiter(others.quota, { meterProvider: h.meterProvider })
    instrumentFallback(others.stale, { meterProvider: h.meterProvider })
    await driveBreaker(breaker)
    await driveRetry(retries)
    await driveOthers(others)

    const resourceMetrics = await h.collect()
    const text = new PrometheusSerializer().serialize(resourceMetrics)
    const types = new Map([...text.matchAll(/^# TYPE (\S+) (\S+)$/gm)].map(([, name, type]) => [name, type] as const))

    const metrics = resourceMetrics.scopeMetrics.flatMap(scope => scope.metrics)
    expect(metrics).toHaveLength(17)
    for (const metric of metrics) {
      const base = metric.descriptor.name.replaceAll('.', '_')
      const exposed = [...types.keys()].filter(name => name.startsWith(base))
      const expected =
        metric.dataPointType === DataPointType.HISTOGRAM
          ? 'histogram'
          : metric.dataPointType === DataPointType.SUM && metric.isMonotonic
            ? 'counter'
            : 'gauge'

      expect(exposed, base).toHaveLength(1)
      expect(types.get(exposed[0]), base).toBe(expected)
    }

    expect(text).toContain('resilience_circuit_breaker_name="inventory"')
    expect(text).toContain('resilience_retry_name="inventory"')
    // The exporter appends labels of its own, such as otel_scope_name, after the instrument's.
    const series = (name: string, labels: string, value: number) =>
      new RegExp(`^${name}\\{${labels}(,[^}]*)?\\} ${value}$`, 'm')
    expect(text).toMatch(series('resilience_bulkhead_rejected_calls_total', 'resilience_bulkhead_name="inventory"', 1))
    expect(text).toMatch(
      series(
        'resilience_time_limiter_calls_total',
        'resilience_time_limiter_name="inventory",resilience_time_limiter_kind="timeout"',
        1,
      ),
    )
    expect(text).toMatch(
      series('resilience_rate_limiter_rejected_calls_total', 'resilience_rate_limiter_name="inventory"', 1),
    )
    expect(text).toMatch(
      series(
        'resilience_fallback_calls_total',
        'resilience_fallback_name="inventory",resilience_fallback_kind="recovered"',
        1,
      ),
    )
  })
})
