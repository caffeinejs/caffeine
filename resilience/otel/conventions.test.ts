import { afterEach, describe, expect, it } from 'vitest'

import { instrumentCircuitBreaker, instrumentRetry } from './otel.js'
import { driveBreaker, driveRetry, metricsHarness, newStrategies, type MetricsHarness } from './otel.testkit.js'

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
    await driveBreaker(breaker)
    await driveRetry(retries)

    const descriptors = (await h.collect()).scopeMetrics.flatMap(scope => scope.metrics.map(m => m.descriptor))

    expect(descriptors).toHaveLength(8)
    for (const { name, unit } of descriptors) {
      expect(name, name).toMatch(/^resilience(\.[a-z][a-z0-9_]*)+$/)
      expect(name, name).not.toMatch(/_total$/)
      expect(name, name).not.toMatch(/(^|[._])(seconds|second|milliseconds|ms|percent)($|[._])/)
      expect(['s', '1', '{call}'], name).toContain(unit)
      if (unit === 's') {
        expect(name, name).toMatch(/\.duration$/)
      }
    }
  })
})
