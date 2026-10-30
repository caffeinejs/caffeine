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

// Read from what the SDK actually collected, so an instrument added later is held to the same rules.
describe('OpenTelemetry naming conventions', () => {
  it('holds every instrument to the semantic-convention naming and unit rules', async () => {
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

    const descriptors = (await h.collect()).scopeMetrics.flatMap(scope => scope.metrics.map(m => m.descriptor))

    expect(descriptors).toHaveLength(17)
    for (const { name, unit } of descriptors) {
      expect(name, name).toMatch(/^resilience(\.[a-z][a-z0-9_]*)+$/)
      expect(name, name).not.toMatch(/_total$/)
      expect(name, name).not.toMatch(/(^|[._])(seconds|second|milliseconds|ms|percent)($|[._])/)
      expect(['s', '1', '{call}', '{permission}'], name).toContain(unit)
      if (unit === 's') {
        expect(name, name).toMatch(/\.duration$/)
      }
    }
  })
})
