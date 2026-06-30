import { describe, it, expect } from 'vitest'
import { parseDuration } from './index.js'

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
