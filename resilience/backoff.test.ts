import { afterEach, describe, expect, it, vi } from 'vitest'

import { exponential } from './backoff.js'
import { ErrInvalidOption } from './errors.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('exponential', () => {
  // Clients that back off in lockstep reach a recovering dependency together, so the default spreads every delay.
  it.each([
    [0, [250, 500, 1_000, 2_000]],
    [1, [750, 1_500, 3_000, 6_000]],
  ])(
    'doubles from 500 ms by default, each delay spread by half of it: Math.random() = %d gives %o',
    (random, delays) => {
      vi.spyOn(Math, 'random').mockReturnValue(random)

      expect([1, 2, 3, 4].map(exponential())).toEqual(delays)
    },
  )

  // An unbounded default would reach delays no caller wants and, eventually, values setTimeout cannot honour.
  it('caps at 30 s by default, spreading capped delays over [15 s, 30 s]', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const backoff = exponential()

    expect([backoff(7), backoff(1_000)]).toEqual([15_000, 15_000])
    random.mockReturnValue(1)
    expect([backoff(7), backoff(1_000)]).toEqual([30_000, 30_000])
  })

  it('waits exactly with jitter 0', () => {
    const backoff = exponential({ jitter: 0 })

    expect([1, 2, 3, 4, 1_000].map(backoff)).toEqual([500, 1_000, 2_000, 4_000, 30_000])
  })

  it('applies initial delay, multiplier and cap as given', () => {
    const backoff = exponential({ initialDelay: 100, multiplier: 3, maxDelay: 1_000, jitter: 0 })

    expect([1, 2, 3, 4].map(backoff)).toEqual([100, 300, 900, 1_000])
  })

  it('allows an infinite cap', () => {
    expect(exponential({ maxDelay: Infinity, jitter: 0 })(12)).toBe(500 * 2 ** 11)
  })

  // Clients that all wait exactly the cap reach a recovering dependency together.
  it('keeps spreading delays that reached the cap', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.5)
    try {
      const backoff = exponential({ initialDelay: 100, maxDelay: 1_000, jitter: 0.5 })

      expect([backoff(20), backoff(20)]).toEqual([500, 750])
    } finally {
      random.mockRestore()
    }
  })

  // `0 · multiplier^n` is NaN once the power overflows, and NaN must not turn into the maximum delay.
  it('keeps a zero initial delay at zero for any attempt', () => {
    const backoff = exponential({ initialDelay: 0 })

    expect([backoff(1), backoff(5_000)]).toEqual([0, 0])
  })

  it.each([
    [{ initialDelay: -1 }, 'initialDelay must be a finite Duration of at least 0s, got -1ms'],
    [{ initialDelay: Number.NaN }, 'initialDelay must be a finite Duration of at least 0s, got NaN'],
    [{ multiplier: 0.5 }, 'multiplier must be a finite number of at least 1, got 0.5'],
    [{ maxDelay: -5 }, 'maxDelay must be a Duration of at least 0s, got -5ms'],
    [{ jitter: 1 }, 'jitter must be at least 0 and less than 1, got 1'],
    [{ jitter: -0.1 }, 'jitter must be at least 0 and less than 1, got -0.1'],
  ])('rejects %o at creation, not at the first retry', (options, reason) => {
    expect(() => exponential(options)).toThrow(ErrInvalidOption)
    expect(() => exponential(options)).toThrow(`Cannot create exponential backoff: ${reason}`)
  })
})
