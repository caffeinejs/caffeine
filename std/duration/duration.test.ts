import { describe, it, expect } from 'vitest'

import { DURATION_PATTERN, parseDuration, toMillis } from './index.js'

describe('parseDuration', () => {
  describe('numbers', () => {
    it('returns number as-is (seconds)', () => {
      expect(parseDuration(60)).toBe(60)
      expect(parseDuration(0)).toBe(0)
      expect(parseDuration(3600)).toBe(3600)
    })
  })

  describe('strings — single unit', () => {
    it('"300ms" → 0.3', () => {
      expect(parseDuration('300ms')).toBeCloseTo(0.3)
    })

    it('"10s" → 10', () => {
      expect(parseDuration('10s')).toBe(10)
    })

    it('"5m" → 300', () => {
      expect(parseDuration('5m')).toBe(300)
    })

    it('"1h" → 3600', () => {
      expect(parseDuration('1h')).toBe(3600)
    })

    it('"7d" → 604800', () => {
      expect(parseDuration('7d')).toBe(604800)
    })
  })

  describe('strings — compound', () => {
    it('"1h30m" → 5400', () => {
      expect(parseDuration('1h30m')).toBe(5400)
    })

    it('"1h30m10s" → 5410', () => {
      expect(parseDuration('1h30m10s')).toBe(5410)
    })

    it('"1d12h" → 129600', () => {
      expect(parseDuration('1d12h')).toBe(129600)
    })
  })

  describe('edge cases', () => {
    it('"0s" → 0', () => {
      expect(parseDuration('0s')).toBe(0)
    })

    it('decimal "1.5h" → 5400', () => {
      expect(parseDuration('1.5h')).toBe(5400)
    })

    it('unknown/empty string → 0', () => {
      expect(parseDuration('')).toBe(0)
      expect(parseDuration('invalid')).toBe(0)
    })
  })
})

describe('DURATION_PATTERN', () => {
  // The config-validation gate in front of parseDuration, which returns 0 for anything it does not recognize.
  // A field typed $t.Duration must reject those strings before they are ever parsed.
  const re = new RegExp(DURATION_PATTERN)

  it('matches the grammar parseDuration accepts', () => {
    for (const value of ['1h30m', '300ms', '1.5h', '1h30m10s', '0s', '7d']) {
      expect(re.test(value)).toBe(true)
    }
  })

  it('rejects anything parseDuration would read as 0', () => {
    for (const value of ['5 hours', '', 'invalid', '10x', '1h ', 'h', '1']) {
      expect(re.test(value)).toBe(false)
    }
  })
})

describe('toMillis', () => {
  // parseDuration returns seconds for a string and passes a number through, so the conversion has to be explicit.
  it('treats a bare number as milliseconds', () => {
    expect(toMillis(5_000)).toBe(5_000)
  })

  it('converts a duration string to milliseconds', () => {
    expect(toMillis('5s')).toBe(5_000)
    expect(toMillis('500ms')).toBe(500)
    expect(toMillis('2m')).toBe(120_000)
    expect(toMillis('1m30s')).toBe(90_000)
  })
})
