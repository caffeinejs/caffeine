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
 * Anchored: the grammar {@link parseDuration} reads, without a sign, so it admits no negative span.
 */
export const DURATION_PATTERN = String.raw`^(?:0|(?:(?:\d+(?:\.\d*)?|\.\d+)(?:ns|us|µs|μs|ms|s|m|h|d))+)$`

// Each unit in nanoseconds, the parser's working unit. Whole numbers, summed exactly.
const UNITS: ReadonlyMap<string, bigint> = new Map([
  ['ns', 1n],
  ['us', 1_000n],
  ['µs', 1_000n], // U+00B5 micro sign
  ['μs', 1_000n], // U+03BC Greek small letter mu
  ['ms', 1_000_000n],
  ['s', 1_000_000_000n],
  ['m', 60_000_000_000n],
  ['h', 3_600_000_000_000n],
  ['d', 86_400_000_000_000n],
])

// Go's bound: a duration is an int64 count of nanoseconds, 2^63 - 1 ahead and 2^63 back, about 292 years.
const LIMIT = 1n << 63n

const GRAMMAR = 'expected a sequence of decimal numbers, each with a unit: ns, us, µs, ms, s, m, h or d'
const NO_UNIT = 'a number has no unit: use ns, us, µs, ms, s, m, h or d'
const OUT_OF_RANGE = 'out of range: a duration spans at most about 292 years'

/**
 * Reads duration text as a {@link Duration}: `'300ms'`, `'1.5h'`, `'-2h45m'` or `'7d'`, a `d` being exactly 24
 * hours.
 *
 * A possibly signed sequence of decimal numbers, each with an optional fraction and a unit: `ns`, `us` (or `µs`),
 * `ms`, `s`, `m`, `h` or `d`. `'0'` alone needs no unit. No spaces.
 *
 * @throws {@link ErrInvalidDuration} if the text is outside the grammar, or spans more than about 292 years.
 */
export function parseDuration(text: string): Duration {
  const negative = text.startsWith('-')
  let rest = negative || text.startsWith('+') ? text.slice(1) : text

  if (rest === '0') {
    return 0
  }

  if (rest === '') {
    throw new ErrInvalidDuration(text, GRAMMAR)
  }

  let total = 0n

  while (rest !== '') {
    const part = readPart(text, rest)

    total += part.span
    if (total > LIMIT) {
      throw new ErrInvalidDuration(text, OUT_OF_RANGE)
    }

    rest = part.rest
  }

  // 2^63 is reachable going back only.
  if (!negative && total === LIMIT) {
    throw new ErrInvalidDuration(text, OUT_OF_RANGE)
  }

  const value = Number(total) / 1e6
  return negative && total !== 0n ? -value : value
}

/**
 * Reads a span written either way, as text or as a {@link Duration}.
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

  if (wholeSeconds === 0 && subsecond === 0) {
    return '0s'
  }

  const text = wholeSeconds === 0 ? subsecondText(subsecond) : clockText(wholeSeconds, subsecond)
  return d < 0 ? `-${text}` : text
}

/** `d` in hours, its fraction kept: `hours(90 * Minute)` is `1.5`. */
export function hours(d: Duration): number {
  return d / Hour
}

/** `d` in minutes, its fraction kept: `minutes(90 * Second)` is `1.5`. */
export function minutes(d: Duration): number {
  return d / Minute
}

/** `d` in seconds, its fraction kept: `seconds(300 * Millisecond)` is `0.3`. */
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
  if (Number.isNaN(step) || step <= 0) {
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
  if (Number.isNaN(step) || step <= 0) {
    return d
  }

  const span = nanoseconds(d)
  const remainder = Math.abs(span % step)
  const rounded =
    remainder + remainder < step ? span - Math.sign(span) * remainder : span + Math.sign(span) * (step - remainder)

  return zeroUnsigned(rounded / 1e6)
}

/** `d` without its sign. */
export function abs(d: Duration): Duration {
  return Math.abs(d)
}

function isDigit(text: string, at: number): boolean {
  const code = text.codePointAt(at)
  return code !== undefined && code >= 48 && code <= 57
}

// Where the run of digits starting at `from` ends.
function digitsEnd(text: string, from: number): number {
  let at = from
  while (at < text.length && isDigit(text, at)) {
    at++
  }
  return at
}

// One number and its unit from the front of `rest`, in nanoseconds, and the text after them.
function readPart(text: string, rest: string): { span: bigint; rest: string } {
  if (!rest.startsWith('.') && !isDigit(rest, 0)) {
    throw new ErrInvalidDuration(text, GRAMMAR)
  }

  const wholeEnd = digitsEnd(rest, 0)
  const unitAt = rest.startsWith('.', wholeEnd) ? digitsEnd(rest, wholeEnd + 1) : wholeEnd
  const fraction = rest.slice(wholeEnd + 1, unitAt)

  // A dot with no digit on either side, `.s`, is not a number.
  if (wholeEnd === 0 && fraction === '') {
    throw new ErrInvalidDuration(text, GRAMMAR)
  }

  let unitEnd = unitAt
  while (unitEnd < rest.length && !rest.startsWith('.', unitEnd) && !isDigit(rest, unitEnd)) {
    unitEnd++
  }

  if (unitEnd === unitAt) {
    throw new ErrInvalidDuration(text, NO_UNIT)
  }

  const name = rest.slice(unitAt, unitEnd)
  const unit = UNITS.get(name)
  if (unit === undefined) {
    throw new ErrInvalidDuration(text, `unknown unit "${name}": use ns, us, µs, ms, s, m, h or d`)
  }

  const whole = wholeNumber(rest.slice(0, wholeEnd))
  if (whole === undefined || whole > LIMIT / unit) {
    throw new ErrInvalidDuration(text, OUT_OF_RANGE)
  }

  const span = whole * unit + fractionOf(fraction, unit)
  if (span > LIMIT) {
    throw new ErrInvalidDuration(text, OUT_OF_RANGE)
  }

  return { span, rest: rest.slice(unitEnd) }
}

// The digits before the point, or `undefined` past 2^63. Leading zeros are dropped first, so a long run of them
// costs nothing, and more than 19 digits left is past 2^63 without converting them.
function wholeNumber(digits: string): bigint | undefined {
  let first = 0
  while (first < digits.length - 1 && digits[first] === '0') {
    first++
  }

  const significant = digits.slice(first)
  if (significant.length > 19) {
    return undefined
  }

  const value = BigInt(significant || '0')
  return value > LIMIT ? undefined : value
}

// The fraction's share of the unit, in whole nanoseconds, as Go's `leadingFraction` computes it: digits are kept
// while their value stays within 2^63, the rest ignored, and the share is taken in floating point and truncated.
function fractionOf(fraction: string, unit: bigint): bigint {
  let value = 0n
  let scale = 1

  for (let at = 0; at < fraction.length; at++) {
    if (value > (LIMIT - 1n) / 10n) {
      break
    }

    const next = value * 10n + BigInt(fraction.charAt(at))
    if (next > LIMIT) {
      break
    }

    value = next
    scale *= 10
  }

  return value === 0n ? 0n : BigInt(Math.trunc(Number(value) * (Number(unit) / scale)))
}

// A span under a second, in the unit that keeps its leading digit non-zero.
function subsecondText(ns: number): string {
  if (ns < 1e3) {
    return `${ns}ns`
  }

  return ns < 1e6 ? `${decimal(ns, 3)}µs` : `${decimal(ns, 6)}ms`
}

// A span of a second or more, from its largest unit down to the seconds. Leading zero units are left out.
function clockText(wholeSeconds: number, subsecond: number): string {
  const text = `${decimal((wholeSeconds % 60) * 1e9 + subsecond, 9)}s`

  const wholeMinutes = Math.floor(wholeSeconds / 60)
  if (wholeMinutes === 0) {
    return text
  }

  const wholeHours = Math.floor(wholeMinutes / 60)
  if (wholeHours === 0) {
    return `${wholeMinutes}m${text}`
  }

  const wholeDays = Math.floor(wholeHours / 24)
  const clock = `${wholeHours % 24}h${wholeMinutes % 60}m${text}`
  return wholeDays === 0 ? clock : `${wholeDays}d${clock}`
}

// `value / 10^places` written out with the fraction's trailing zeros dropped, as Go prints a duration.
function decimal(value: number, places: number): string {
  const scale = 10 ** places
  const digits = String(value % scale).padStart(places, '0')

  let end = digits.length
  while (end > 0 && digits[end - 1] === '0') {
    end--
  }

  const whole = String(Math.floor(value / scale))
  return end === 0 ? whole : `${whole}.${digits.slice(0, end)}`
}

function wholeOf(value: number): number {
  return zeroUnsigned(Math.trunc(value))
}

// A span has one zero: `-0` would print, compare and serialize apart from it.
function zeroUnsigned(value: number): number {
  return value === 0 ? 0 : value
}
