import { describe, it, expect } from 'vitest'

import {
  abs,
  Day,
  duration,
  DURATION_PATTERN,
  ErrInvalidDuration,
  formatDuration,
  Hour,
  hours,
  Microsecond,
  microseconds,
  Millisecond,
  milliseconds,
  Minute,
  minutes,
  Nanosecond,
  nanoseconds,
  parseDuration,
  round,
  Second,
  seconds,
  truncate,
} from './index.js'

const pattern = new RegExp(DURATION_PATTERN)

// Go's own `parseDurationTests`, unsigned, with the expected span in nanoseconds, plus `d`.
// Every row is checked against the parser and the pattern alike: the pattern is what configuration validates, so
// a value it admits must parse, and to the same span Go would read.
const VALID: ReadonlyArray<readonly [text: string, nanoseconds: number]> = [
  ['0', 0],
  ['5s', 5e9],
  ['30s', 30e9],
  ['1478s', 1478e9],
  ['5.0s', 5e9],
  ['5.6s', 5.6e9],
  ['5.s', 5e9],
  ['.5s', 5e8],
  ['1.0s', 1e9],
  ['1.00s', 1e9],
  ['1.004s', 1.004e9],
  ['1.0040s', 1.004e9],
  ['100.00100s', 100.001e9],
  ['10ns', 10],
  ['11us', 11e3],
  ['12µs', 12e3], // U+00B5 micro sign
  ['12μs', 12e3], // U+03BC Greek small letter mu
  ['13ms', 13e6],
  ['14s', 14e9],
  ['15m', 15 * 60e9],
  ['16h', 16 * 3600e9],
  ['3h30m', 3.5 * 3600e9],
  ['10.5s4m', 4 * 60e9 + 10.5e9],
  ['1h2m3s4ms5us6ns', 3600e9 + 2 * 60e9 + 3e9 + 4e6 + 5e3 + 6],
  ['39h9m14.425s', 39 * 3600e9 + 9 * 60e9 + 14.425e9],
  ['52763797000ns', 52763797000],
  // More than 9 digits after the point: the fraction is read as Go reads it, not cut at nanoseconds.
  ['0.3333333333333333333h', 20 * 60e9],
  ['0.100000000000000000000h', 6 * 60e9],
  ['0.830103483285477580700h', 49 * 60e9 + 48e9 + 372539827],
  // Go takes a fraction's share in floating point too, so this is one second in Go as well.
  ['0.9999999999999999999s', 1e9],
  // The largest span, 2^63 - 1 nanoseconds, which a double holds as 2^63.
  ['9223372036854775807ns', 2 ** 63],
  ['9223372036854775.807us', 2 ** 63],
  ['9223372036s854ms775us807ns', 2 ** 63],
  // Days, which Go leaves out: exactly 24 hours each.
  ['7d', 7 * 86400e9],
  ['1d12h', 36 * 3600e9],
  ['1.5d', 36 * 3600e9],
  ['2562047h', 2562047 * 3600e9],
]

// Outside the grammar. The parser throws for each and the pattern refuses each, so no misspelling reaches a timer
// as `0`, the way the previous parser read it.
const INVALID: readonly string[] = [
  '',
  '3', // a number with no unit
  '-',
  's',
  '.',
  '-.',
  '.s',
  '+.s',
  '\x85\x85',
  '\xffff',
  'hello \xffff world',
  '�',
  '1h30', // the last number has no unit
  '10x',
  '5 hours',
  '1 h',
  '1hm',
  '1e3s',
  '0x10s',
  'constructor', // a unit is looked up by name, not on an object's prototype
  '1h ',
  ' 1h',
]

describe('parseDuration', () => {
  it.each(VALID)('reads %o', (text, ns) => {
    expect(parseDuration(text)).toBe(ns / 1e6)
  })

  it.each(INVALID)('refuses %o', text => {
    expect(() => parseDuration(text)).toThrow(ErrInvalidDuration)
  })

  it('reads a sign, as Go does', () => {
    expect(parseDuration('-5s')).toBe(-5 * Second)
    expect(parseDuration('+5s')).toBe(5 * Second)
    expect(parseDuration('-2m3.4s')).toBe(-(2 * Minute + 3.4 * Second))
    expect(parseDuration('-0')).toBe(0)
    expect(parseDuration('+0')).toBe(0)
  })

  it('reads a span in milliseconds, whatever its unit', () => {
    expect(parseDuration('1.1s')).toBe(1_100)
    expect(parseDuration('300ms')).toBe(300)
    expect(parseDuration('1.5h')).toBe(5_400_000)
  })

  it('says what is wrong', () => {
    expect(() => parseDuration('1h30')).toThrow('Cannot parse duration "1h30": a number has no unit')
    expect(() => parseDuration('5 hours')).toThrow('Cannot parse duration "5 hours": unknown unit " hours"')
    expect(() => parseDuration('3000000h')).toThrow('Cannot parse duration "3000000h": out of range')
  })

  // Summed exactly, as Go sums its int64: 2^63 - 1 nanoseconds ahead, 2^63 back, and not one more either way.
  it.each([
    '9223372036854775808ns',
    '9223372036854775810ns',
    '-9223372036854775809ns',
    '9223372036854776us',
    '9223372036854775.808us',
    '9223372036854ms775us808ns',
  ])('refuses %o, one past the bound', text => {
    expect(() => parseDuration(text)).toThrow(`Cannot parse duration "${text}": out of range`)
  })

  it.each(['-9223372036854775808ns', '-9223372036854775.808us', '-9223372036s854ms775us808ns'])(
    'reads %o, the bound going back',
    text => {
      expect(parseDuration(text)).toBe(-(2 ** 63) / 1e6)
    },
  )

  it('refuses a span past Go’s bound of 2^63 nanoseconds, and a run of digits too long to be finite', () => {
    expect(() => parseDuration('2562048h')).toThrow(ErrInvalidDuration)
    expect(() => parseDuration('3000000h')).toThrow(ErrInvalidDuration)
    expect(() => parseDuration(`${'9'.repeat(400)}s`)).toThrow(ErrInvalidDuration)
  })

  it('reads a fraction too long to be finite', () => {
    expect(parseDuration(`0.${'1'.repeat(400)}h`)).toBe(6 * Minute + 40 * Second)
  })

  it('reports the value and the grammar', () => {
    try {
      parseDuration('soon')
      expect.unreachable('parseDuration should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ErrInvalidDuration)
      expect((error as ErrInvalidDuration).name).toBe('ErrInvalidDuration')
      expect((error as ErrInvalidDuration).code).toBe('ERR_INVALID_DURATION')
      expect((error as ErrInvalidDuration).message).toContain('Cannot parse duration "soon"')
      expect((error as ErrInvalidDuration).message).toContain('ns, us, µs, ms, s, m, h or d')
    }
  })

  it('gives up on a long run of digits without retrying at every digit', () => {
    const text = `${'9'.repeat(100_000)}x2s`
    const started = performance.now()

    expect(() => parseDuration(text)).toThrow(ErrInvalidDuration)
    expect(pattern.test(text)).toBe(false)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe('DURATION_PATTERN', () => {
  it.each(VALID)('admits %o', text => {
    expect(pattern.test(text)).toBe(true)
  })

  it.each(INVALID)('refuses %o', text => {
    expect(pattern.test(text)).toBe(false)
  })

  // A configured timeout or lifetime is never negative, though `parseDuration` reads a sign.
  it.each(['-5s', '+5s', '-0', '+0', '-1.5h'])('refuses the signed %o', text => {
    expect(pattern.test(text)).toBe(false)
    expect(() => parseDuration(text)).not.toThrow()
  })
})

// Go's own `durationTests`, plus days. The text is what an error message or a log line shows a reader.
const FORMATTED: ReadonlyArray<readonly [text: string, duration: number]> = [
  ['0s', 0],
  ['1ns', 1 * Nanosecond],
  ['1.1µs', 1.1 * Microsecond],
  ['2.2ms', 2.2 * Millisecond],
  ['3.3s', 3.3 * Second],
  ['4m5s', 4 * Minute + 5 * Second],
  ['4m5.001s', 4 * Minute + 5_001 * Millisecond],
  ['5h6m7.001s', 5 * Hour + 6 * Minute + 7_001 * Millisecond],
  ['8m0.000000001s', 8 * Minute + 1 * Nanosecond],
  ['1h0m0s', Hour],
  ['1m30s', 90 * Second],
  ['300ms', 0.1 * 3 * Second],
  ['1d1h0m0s', 25 * Hour],
  ['7d0h0m0s', 7 * Day],
  ['3d0h3m0.5s', 72 * Hour + 3 * Minute + 500 * Millisecond],
  ['365d0h0m0.0005s', 365 * Day + 500 * Microsecond],
  ['-1h30m0s', -1.5 * Hour],
  ['-1ns', -1 * Nanosecond],
]

describe('formatDuration', () => {
  it.each(FORMATTED)('writes %o', (text, d) => {
    expect(formatDuration(d)).toBe(text)
  })

  it.each(FORMATTED)('writes %o so that it reads back', (text, d) => {
    expect(nanoseconds(parseDuration(text))).toBe(nanoseconds(d))
  })

  it('rounds to the nanosecond', () => {
    expect(formatDuration(0.000_000_4)).toBe('0s')
    expect(formatDuration(0.000_000_6)).toBe('1ns')
    expect(formatDuration(999.999_999_9)).toBe('1s')
  })

  // It is the formatter of error messages, which must not throw on the bad value they describe.
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('writes %p as JavaScript does', value => {
    expect(formatDuration(value)).toBe(String(value))
  })
})

describe('duration', () => {
  it('reads text', () => {
    expect(duration('7d')).toBe(7 * Day)
    expect(duration('1h30m')).toBe(90 * Minute)
  })

  it('passes a number through, as milliseconds', () => {
    expect(duration(5_000)).toBe(5 * Second)
    expect(duration(-5)).toBe(-5)
    expect(duration(0)).toBe(0)
  })

  it.each(['soon', '', '5 hours'])('refuses the text %o', text => {
    expect(() => duration(text)).toThrow(ErrInvalidDuration)
  })

  // A third-party option handed `NaN` would read it as it pleases, often as "no limit at all".
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('refuses the number %p', value => {
    expect(() => duration(value)).toThrow('expected a finite number of milliseconds')
  })
})

describe('units', () => {
  // The constants are Go's, scaled to milliseconds: `5 * Second` is what a timer takes.
  it('count milliseconds', () => {
    expect([Nanosecond, Microsecond, Millisecond, Second, Minute, Hour, Day]).toEqual([
      1e-6, 1e-3, 1, 1_000, 60_000, 3_600_000, 86_400_000,
    ])
  })

  it('convert as Go converts', () => {
    expect(nanoseconds(-1_000 * Nanosecond)).toBe(-1_000)
    expect(nanoseconds(1 * Nanosecond)).toBe(1)
    expect(microseconds(-1_000 * Nanosecond)).toBe(-1)
    expect(microseconds(999 * Nanosecond)).toBe(0)
    expect(milliseconds(1_000_000 * Nanosecond)).toBe(1)
    expect(milliseconds(-1_999_999 * Nanosecond)).toBe(-1)
    expect(seconds(300 * Millisecond)).toBe(0.3)
    expect(minutes(-Minute)).toBe(-1)
    expect(minutes(3 * Microsecond)).toBeCloseTo(5e-8, 20)
    expect(hours(Hour)).toBe(1)
    expect(hours(36 * Nanosecond)).toBeCloseTo(1e-11, 25)
    expect(abs(-Minute)).toBe(Minute)
  })
})

describe('truncate', () => {
  // Go's `durationTruncateTests` that float64 can hold.
  it.each([
    [0, Second, 0],
    [Minute, -7 * Second, Minute],
    [Minute, 0, Minute],
    [Minute, Nanosecond, Minute],
    [Minute + 10 * Second, 10 * Second, Minute + 10 * Second],
    [2 * Minute + 10 * Second, Minute, 2 * Minute],
    [10 * Minute + 10 * Second, 3 * Minute, 9 * Minute],
    [Minute + 10 * Second, Minute + 10 * Second + Nanosecond, 0],
    [Minute + 10 * Second, Hour, 0],
    [-Minute, Second, -Minute],
    [-10 * Minute, 3 * Minute, -9 * Minute],
    [-10 * Minute, Hour, 0],
  ])('truncate(%d, %d) is %d', (d, m, want) => {
    expect(truncate(d, m)).toBe(want)
  })
})

describe('round', () => {
  // Go's `durationRoundTests` that float64 can hold: a halfway value goes away from zero.
  it.each([
    [0, Second, 0],
    [Minute, -11 * Second, Minute],
    [Minute, 0, Minute],
    [Minute, Nanosecond, Minute],
    [2 * Minute, Minute, 2 * Minute],
    [2 * Minute + 10 * Second, Minute, 2 * Minute],
    [2 * Minute + 30 * Second, Minute, 3 * Minute],
    [2 * Minute + 50 * Second, Minute, 3 * Minute],
    [-Minute, Nanosecond, -Minute],
    [-2 * Minute, Minute, -2 * Minute],
    [-2 * Minute - 10 * Second, Minute, -2 * Minute],
    [-2 * Minute - 30 * Second, Minute, -3 * Minute],
    [-2 * Minute - 50 * Second, Minute, -3 * Minute],
  ])('round(%d, %d) is %d', (d, m, want) => {
    expect(round(d, m)).toBe(want)
  })
})
