import { describe, expect, it, vi } from 'vitest'

import { exponential } from './backoff.js'
import { ErrInvalidOption } from './errors.js'

describe('exponential', () => {
  it('doubles from 500 ms by default', () => {
    const backoff = exponential()

    expect([1, 2, 3, 4].map(backoff)).toEqual([500, 1_000, 2_000, 4_000])
  })

  // An unbounded default would reach delays no caller wants and, eventually, values setTimeout cannot honour.
  it('caps at 30 s by default', () => {
    const backoff = exponential()

    expect(backoff(7)).toBe(30_000)
    expect(backoff(1_000)).toBe(30_000)
  })

  it('applies initial delay, multiplier and cap as given', () => {
    const backoff = exponential({ initialDelayMs: 100, multiplier: 3, maxDelayMs: 1_000 })

    expect([1, 2, 3, 4].map(backoff)).toEqual([100, 300, 900, 1_000])
  })

  it('allows an infinite cap', () => {
    expect(exponential({ maxDelayMs: Infinity })(12)).toBe(500 * 2 ** 11)
  })

  // Clients that all wait exactly the cap reach a recovering dependency together.
  it('keeps spreading delays that reached the cap', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.5)
    try {
      const backoff = exponential({ initialDelayMs: 100, maxDelayMs: 1_000, jitter: 0.5 })

      expect([backoff(20), backoff(20)]).toEqual([500, 750])
    } finally {
      random.mockRestore()
    }
  })

  // `0 · multiplier^n` is NaN once the power overflows, and NaN must not turn into the maximum delay.
  it('keeps a zero initial delay at zero for any attempt', () => {
    const backoff = exponential({ initialDelayMs: 0 })

    expect([backoff(1), backoff(5_000)]).toEqual([0, 0])
  })

  it.each([
    [{ initialDelayMs: -1 }, 'initialDelayMs must be a finite number of at least 0, got -1'],
    [{ initialDelayMs: Number.NaN }, 'initialDelayMs must be a finite number of at least 0, got NaN'],
    [{ multiplier: 0.5 }, 'multiplier must be a finite number of at least 1, got 0.5'],
    [{ maxDelayMs: -5 }, 'maxDelayMs must be a number of at least 0, got -5'],
    [{ jitter: 1 }, 'jitter must be at least 0 and less than 1, got 1'],
    [{ jitter: -0.1 }, 'jitter must be at least 0 and less than 1, got -0.1'],
  ])('rejects %o at creation, not at the first retry', (options, reason) => {
    expect(() => exponential(options)).toThrow(ErrInvalidOption)
    expect(() => exponential(options)).toThrow(`Cannot create exponential backoff: ${reason}`)
  })
})
