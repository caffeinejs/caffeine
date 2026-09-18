import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { exponential } from './backoff.js'

describe('exponential (property)', () => {
  // Jitter spreads retries of many clients apart; it must never push a delay outside its band or past the cap.
  it.prop([
    fc.integer({ min: 1, max: 40 }),
    fc.double({ min: 0, max: 10_000, noNaN: true }),
    fc.double({ min: 1, max: 4, noNaN: true }),
    fc.double({ min: 0, max: 10_000_000, noNaN: true }),
    fc.double({ min: 0, max: 0.999, noNaN: true }),
  ])(
    'keeps every delay within its jitter band and under the cap',
    (attempt, initialDelayMs, multiplier, maxDelayMs, jitter) => {
      const delay = exponential({ initialDelayMs, multiplier, maxDelayMs, jitter })(attempt)
      const base = initialDelayMs * multiplier ** (attempt - 1)
      const tolerance = 1e-9 * Math.max(1, base)

      expect(delay).toBeLessThanOrEqual(maxDelayMs)
      expect(delay).toBeGreaterThanOrEqual(Math.min(base * (1 - jitter), maxDelayMs) - tolerance)
      expect(delay).toBeLessThanOrEqual(Math.min(base * (1 + jitter), maxDelayMs) + tolerance)
    },
  )
})
