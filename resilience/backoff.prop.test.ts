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
    (attempt, initialDelay, multiplier, maxDelay, jitter) => {
      const delay = exponential({ initialDelay, multiplier, maxDelay, jitter })(attempt)
      const base = Math.min(initialDelay * multiplier ** (attempt - 1), maxDelay)
      const tolerance = 1e-9 * Math.max(1, base)

      expect(delay).toBeLessThanOrEqual(maxDelay)
      expect(delay).toBeGreaterThanOrEqual(base * (1 - jitter) - tolerance)
      expect(delay).toBeLessThanOrEqual(Math.min(base * (1 + jitter), maxDelay) + tolerance)
    },
  )
})
