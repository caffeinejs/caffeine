import { ErrInvalidDuration } from './errors.js'

/**
 * A span of time, in milliseconds: the unit timers take.
 *
 * Write one with the unit constants, `5 * Second` or `90 * Minute`, read one from text with {@link parseDuration} or
 * {@link duration}, and print one with {@link formatDuration}. A span shorter than a millisecond is a fraction:
 * {@link Microsecond} is `0.001`.
 */
export type Duration = number

export const Nanosecond: Duration = 1e-6
export const Microsecond: Duration = 1e-3
export const Millisecond: Duration = 1
export const Second: Duration = 1_000
export const Minute: Duration = 60_000
export const Hour: Duration = 3_600_000
/** Exactly 24 hours: a span, never a calendar day. */
export const Day: Duration = 86_400_000

/**
 * JSON Schema `pattern` for duration text in configuration.
 *
 * Anchored; the grammar {@link parseDuration} accepts, without a sign, so whatever it admits is a span of zero or
 * more: a configured timeout or lifetime is never negative.
 */
export const DURATION_PATTERN = '^(?:0|(?:(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:ns|us|µs|μs|ms|s|m|h|d))+)$'

// Each unit in nanoseconds, the parser's working unit: whole numbers, so the parts of a span add up exactly.
const UNITS: ReadonlyMap<string, number> = new Map([
  ['ns', 1],
  ['us', 1e3],
  ['µs', 1e3], // U+00B5 micro sign
  ['μs', 1e3], // U+03BC Greek small letter mu
  ['ms', 1e6],
  ['s', 1e9],
  ['m', 6e10],
  ['h', 3.6e12],
  ['d', 8.64e13],
])

// Go's bound: a duration is an int64 count of nanoseconds, about 292 years either way.
const MAX_NANOSECONDS = 2 ** 63

const GRAMMAR = 'expected a sequence of decimal numbers, each with a unit: ns, us, µs, ms, s, m, h or d'

/**
 * Reads duration text as a {@link Duration}: `'300ms'`, `'1.5h'`, `'-2h45m'` or `'7d'`, a `d` being exactly 24
 * hours.
 *
 * A possibly signed sequence of decimal numbers, each with an optional fraction and a unit: `ns`, `us` (or `µs`),
 * `ms`, `s`, `m`, `h` or `d`. `'0'` alone needs no unit. No spaces.
 *
 * Unreadable text throws rather than reading as `0`: a timeout of zero aborts everything it guards.
 *
 * @throws {@link ErrInvalidDuration} if the text is outside the grammar, or spans more than about 292 years.
 */
export function parseDuration(text: string): Duration {
  let rest = text
  let negative = false

  if (rest.startsWith('-') || rest.startsWith('+')) {
    negative = rest.startsWith('-')
    rest = rest.slice(1)
  }

  if (rest === '0') {
    return 0
  }

  if (rest === '') {
    throw new ErrInvalidDuration(text, GRAMMAR)
  }

  let total = 0

  while (rest !== '') {
    if (rest[0] !== '.' && !isDigit(rest, 0)) {
      throw new ErrInvalidDuration(text, GRAMMAR)
    }

    const whole = digits(rest, 0)
    let fraction = ''
    let unitAt = whole

    if (rest[whole] === '.') {
      unitAt = digits(rest, whole + 1)
      fraction = rest.slice(whole + 1, unitAt)
    }

    // A dot with no digit on either side, `.s`, is not a number.
    if (whole === 0 && fraction === '') {
      throw new ErrInvalidDuration(text, GRAMMAR)
    }

    let next = unitAt
    while (next < rest.length && rest[next] !== '.' && !isDigit(rest, next)) {
      next++
    }

    if (next === unitAt) {
      throw new ErrInvalidDuration(text, 'a number has no unit: use ns, us, µs, ms, s, m, h or d')
    }

    const name = rest.slice(unitAt, next)
    const unit = UNITS.get(name)
    if (unit === undefined) {
      throw new ErrInvalidDuration(text, `unknown unit "${name}": use ns, us, µs, ms, s, m, h or d`)
    }

    total += Number(rest.slice(0, whole) || '0') * unit + fractionOf(fraction, unit)

    // Also refuses a run of digits too long to be finite.
    if (!(total <= MAX_NANOSECONDS)) {
      throw new ErrInvalidDuration(text, 'out of range: a duration spans at most about 292 years')
    }

    rest = rest.slice(next)
  }

  return negative && total !== 0 ? -total / 1e6 : total / 1e6
}

/**
 * Reads a span written either way, as text or as a {@link Duration}, so the package serves an option Caffeine does
 * not type itself.
 *
 * Text goes through {@link parseDuration}; a number is already milliseconds and passes through.
 *
 * @example
 * // A third-party option in milliseconds
 * staticFiles(s => s.serve(dir, { maxAge: duration('7d') }))
 * // One in seconds
 * { clockTolerance: seconds(duration('30s')) }
 *
 * @throws {@link ErrInvalidDuration} if the text is outside the grammar, or the number is not finite.
 */
export function duration(value: Duration | string): Duration {
  if (typeof value === 'string') {
    return parseDuration(value)
  }

  if (!Number.isFinite(value)) {
    throw new ErrInvalidDuration(value, 'expected a finite number of milliseconds')
  }

  return value
}

/**
 * Writes a {@link Duration} as text, from days down to seconds: `'3d0h3m0.5s'`, `'1h30m0s'`.
 *
 * Leading zero units are left out. A span under a second takes the unit that keeps its leading digit non-zero,
 * `'1.5µs'` or `'300ms'`, and zero is `'0s'`. The output is rounded to the nanosecond and reads back with
 * {@link parseDuration}. A value that is not finite is written as JavaScript writes it, so this never throws.
 */
export function formatDuration(d: Duration): string {
  if (!Number.isFinite(d)) {
    return String(d)
  }

  const span = Math.abs(d)
  const wholeMilliseconds = Math.trunc(span)

  // The whole seconds and the nanoseconds within the last one: both stay exact, however long the span.
  let wholeSeconds = Math.floor(wholeMilliseconds / 1_000)
  let subsecond = (wholeMilliseconds % 1_000) * 1e6 + Math.round((span - wholeMilliseconds) * 1e6)
  if (subsecond >= 1e9) {
    wholeSeconds += 1
    subsecond -= 1e9
  }

  let text: string

  if (wholeSeconds === 0) {
    if (subsecond === 0) {
      return '0s'
    }

    if (subsecond < 1e3) {
      text = `${subsecond}ns`
    } else if (subsecond < 1e6) {
      text = `${decimal(subsecond, 3)}µs`
    } else {
      text = `${decimal(subsecond, 6)}ms`
    }
  } else {
    text = `${decimal((wholeSeconds % 60) * 1e9 + subsecond, 9)}s`

    const minutes = Math.floor(wholeSeconds / 60)
    if (minutes > 0) {
      text = `${minutes % 60}m${text}`

      const hours = Math.floor(minutes / 60)
      if (hours > 0) {
        text = `${hours % 24}h${text}`

        const days = Math.floor(hours / 24)
        if (days > 0) {
          text = `${days}d${text}`
        }
      }
    }
  }

  return d < 0 ? `-${text}` : text
}

export function hours(d: Duration): number {
  return d / Hour
}

export function minutes(d: Duration): number {
  return d / Minute
}

export function seconds(d: Duration): number {
  return d / Second
}

/** The whole milliseconds in `d`, truncated toward zero. */
export function milliseconds(d: Duration): number {
  return wholeOf(nanoseconds(d) / 1e6)
}

/** The whole microseconds in `d`, truncated toward zero. */
export function microseconds(d: Duration): number {
  return wholeOf(nanoseconds(d) / 1e3)
}

/** `d` in nanoseconds, rounded to the nearest: the finest unit a {@link Duration} carries. */
export function nanoseconds(d: Duration): number {
  return zeroUnsigned(Math.round(d * 1e6))
}

/**
 * `d` rounded toward zero to a multiple of `m`. A multiple that is not positive returns `d` unchanged.
 *
 * @example
 * truncate(1_550, Second) // 1_000
 */
export function truncate(d: Duration, m: Duration): Duration {
  const step = nanoseconds(m)
  if (!(step > 0)) {
    return d
  }

  const span = nanoseconds(d)
  return zeroUnsigned((span - (span % step)) / 1e6)
}

/**
 * `d` rounded to the nearest multiple of `m`, a halfway value away from zero. A multiple that is not positive
 * returns `d` unchanged.
 *
 * @example
 * round(1_500, Second) // 2_000
 */
export function round(d: Duration, m: Duration): Duration {
  const step = nanoseconds(m)
  if (!(step > 0)) {
    return d
  }

  const span = nanoseconds(d)
  const remainder = Math.abs(span % step)
  const rounded =
    remainder + remainder < step ? span - Math.sign(span) * remainder : span + Math.sign(span) * (step - remainder)

  return zeroUnsigned(rounded / 1e6)
}

export function abs(d: Duration): Duration {
  return Math.abs(d)
}

function isDigit(text: string, at: number): boolean {
  const code = text.charCodeAt(at)
  return code >= 48 && code <= 57
}

// Where the run of digits starting at `from` ends.
function digits(text: string, from: number): number {
  let at = from
  while (at < text.length && isDigit(text, at)) {
    at++
  }
  return at
}

// The fraction's share of the unit, in whole nanoseconds, computed as Go's `leadingFraction` does: digits are kept
// while their value fits in 2^63, the rest ignored, and the share truncated.
function fractionOf(fraction: string, unit: number): number {
  if (fraction === '') {
    return 0
  }

  const kept =
    fraction.length > 18 && fraction.slice(0, 19) <= '9223372036854775808' ? 19 : Math.min(fraction.length, 18)
  return Math.trunc(Number(fraction.slice(0, kept)) * (unit / 10 ** kept))
}

// `value / 10^places` written out with the fraction's trailing zeros dropped, as Go prints a duration.
function decimal(value: number, places: number): string {
  const scale = 10 ** places
  const fraction = String(value % scale)
    .padStart(places, '0')
    .replace(/0+$/, '')

  return fraction === '' ? String(Math.floor(value / scale)) : `${Math.floor(value / scale)}.${fraction}`
}

function wholeOf(value: number): number {
  return zeroUnsigned(Math.trunc(value))
}

// A span has one zero: `-0` would print, compare and serialize apart from it.
function zeroUnsigned(value: number): number {
  return value === 0 ? 0 : value
}
