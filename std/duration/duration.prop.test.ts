import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import {
  duration,
  DURATION_PATTERN,
  ErrInvalidDuration,
  formatDuration,
  nanoseconds,
  parseDuration,
  round,
  truncate,
} from './index.js'

const pattern = new RegExp(DURATION_PATTERN)

// Each unit spelling and its length in nanoseconds: Go's constants, plus the day.
const UNIT_NANOSECONDS: Readonly<Record<string, number>> = {
  ns: 1,
  us: 1e3,
  µs: 1e3,
  μs: 1e3,
  ms: 1e6,
  s: 1e9,
  m: 6e10,
  h: 3.6e12,
  d: 8.64e13,
}

const ANY_UNIT = fc.constantFrom(...Object.keys(UNIT_NANOSECONDS))

// An amount as Go writes one: digits, a fraction, or both.
function amount(max: number): fc.Arbitrary<string> {
  return fc.oneof(
    fc.nat({ max }).map(String),
    fc.tuple(fc.nat({ max }), fc.stringMatching(/^\d{0,6}$/)).map(([whole, fraction]) => `${whole}.${fraction}`),
    fc.stringMatching(/^\d{1,6}$/).map(fraction => `.${fraction}`),
  )
}

// Duration text in the grammar, unsigned: one part or more, each an amount and a unit.
function durationText(units: fc.Arbitrary<string>, max: number, parts: number): fc.Arbitrary<string> {
  return fc
    .array(
      fc.tuple(amount(max), units).map(([value, unit]) => value + unit),
      { minLength: 1, maxLength: parts },
    )
    .map(each => each.join(''))
}

// Thousands of days at most, far from Go's bound, so every one of these parses.
const DURATION_TEXT = durationText(ANY_UNIT, 999, 5)

// Spans as whole nanoseconds, few enough that a double of milliseconds still tells each nanosecond apart.
const NANOSECONDS = fc.integer({ min: -(2 ** 48), max: 2 ** 48 })

// Whether the parser takes the text for a duration: it reads it, or reads it and finds it too long.
function parses(text: string): boolean {
  try {
    parseDuration(text)
    return true
  } catch (error) {
    if (!(error instanceof ErrInvalidDuration)) {
      throw error
    }

    return error.message.includes('out of range')
  }
}

describe('parseDuration (property)', () => {
  // `DURATION_PATTERN` is what configuration validates and `parseDuration` what then reads the value. A text the
  // pattern admits but the parser refuses fails at bootstrap() as a decode error rather than a validation issue;
  // one the parser reads but the pattern refuses can never be configured. Text close to the grammar is where the
  // two would part, so most candidates are grammatical text with one character added or taken away.
  const nearText = fc.oneof(
    DURATION_TEXT,
    fc
      .tuple(DURATION_TEXT, fc.nat(), fc.constantFrom(' ', '.', '-', '+', 'x', 'e', '0', 'µ', 'μ', 'm', 's', 'd'))
      .map(([text, at, inserted]) => {
        const index = at % (text.length + 1)
        return text.slice(0, index) + inserted + text.slice(index)
      }),
    fc.tuple(DURATION_TEXT, fc.nat()).map(([text, at]) => {
      const index = at % text.length
      return text.slice(0, index) + text.slice(index + 1)
    }),
    fc.string(),
    fc.string({ unit: 'grapheme' }),
  )

  it.prop([nearText], { numRuns: 1_000 })('agrees with DURATION_PATTERN on every unsigned text', text => {
    expect(pattern.test(text)).toBe(parses(text) && !/^[-+]/.test(text))
  })

  // Go reads a sum of parts; a parser that let one part shadow another would read `1h30m` as one of them.
  const smallText = durationText(fc.constantFrom('ns', 'us', 'µs', 'ms', 's', 'm', 'h'), 9, 3)

  it.prop([smallText, smallText])('adds its parts up', (first, second) => {
    expect(nanoseconds(parseDuration(first + second))).toBe(
      nanoseconds(parseDuration(first)) + nanoseconds(parseDuration(second)),
    )
  })

  const wholeAmountOfUnit = ANY_UNIT.chain(unit =>
    fc.tuple(fc.constant(unit), fc.integer({ min: 0, max: Math.floor(2 ** 53 / UNIT_NANOSECONDS[unit]!) })),
  )

  it.prop([wholeAmountOfUnit])('scales a whole amount by its unit, in milliseconds', ([unit, amount]) => {
    expect(parseDuration(`${amount}${unit}`)).toBe((amount * UNIT_NANOSECONDS[unit]!) / 1e6)
  })

  it.prop([DURATION_TEXT])('reads a sign as Go does', text => {
    expect(nanoseconds(parseDuration(`-${text}`))).toBe(nanoseconds(-parseDuration(text)))
    expect(parseDuration(`+${text}`)).toBe(parseDuration(text))
  })
})

describe('formatDuration (property)', () => {
  // What a log line or an error message prints, a reader may paste back into configuration.
  it.prop([NANOSECONDS])('reads back what it writes, to the nanosecond', ns => {
    expect(nanoseconds(parseDuration(formatDuration(ns / 1e6)))).toBe(ns)
  })

  it.prop([fc.integer({ min: -9e9, max: 9e9 })])('reads back a whole number of milliseconds exactly', ms => {
    expect(parseDuration(formatDuration(ms))).toBe(ms)
  })

  it.prop([fc.double({ min: 0, max: 9e12, noNaN: true })])('writes text DURATION_PATTERN admits', d => {
    expect(pattern.test(formatDuration(d))).toBe(true)
  })

  it.prop([fc.double({ min: 0, max: 9e12, noNaN: true })])('writes a negative span with a minus in front', d => {
    const positive = formatDuration(d)

    expect(formatDuration(-d)).toBe(positive === '0s' ? '0s' : `-${positive}`)
  })
})

describe('truncate and round (property)', () => {
  const step = fc.integer({ min: 1, max: 2 ** 40 })

  it.prop([NANOSECONDS, step])('truncate goes toward zero, to a multiple of the step', (ns, by) => {
    const truncated = nanoseconds(truncate(ns / 1e6, by / 1e6))

    expect(Math.abs(truncated % by)).toBe(0)
    expect(Math.abs(truncated)).toBeLessThanOrEqual(Math.abs(ns))
    expect(Math.abs(ns - truncated)).toBeLessThan(by)
  })

  it.prop([NANOSECONDS, step])('round goes to the nearest multiple of the step, a tie away from zero', (ns, by) => {
    const rounded = nanoseconds(round(ns / 1e6, by / 1e6))
    const off = Math.abs(ns - rounded)

    expect(Math.abs(rounded % by)).toBe(0)
    expect(off * 2).toBeLessThanOrEqual(by)
    if (off * 2 === by) {
      expect(Math.abs(rounded)).toBeGreaterThan(Math.abs(ns))
    }
  })
})

describe('duration (property)', () => {
  // A third-party option reached through `duration(...)` gets the same span a Caffeine option would.
  it.prop([fc.double({ noNaN: true, noDefaultInfinity: true })])('passes any finite number through', n => {
    expect(duration(n)).toBe(n)
  })

  it.prop([DURATION_TEXT])('reads text as parseDuration does', text => {
    expect(duration(text)).toBe(parseDuration(text))
  })
})
