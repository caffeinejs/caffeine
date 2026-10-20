import { fc, it } from '@fast-check/vitest'
import { describe, expect } from 'vitest'

import { bytes, BYTES_PATTERN, ErrInvalidByteSize, formatBytes, parseBytes } from './index.js'

const pattern = new RegExp(BYTES_PATTERN)

// Each unit spelling, lower case, and its size in bytes, written out rather than taken from the constants.
const UNIT_BYTES: Readonly<Record<string, number>> = {
  '': 1,
  b: 1,
  k: 1024,
  kb: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  p: 1024 ** 5,
  pb: 1024 ** 5,
}

const ANY_UNIT = fc.constantFrom(...Object.keys(UNIT_BYTES))

// Byte text in the grammar, in any case: up to 20 digits, so leading zeros and amounts past the safe range both occur.
const BYTE_TEXT = fc
  .tuple(fc.stringMatching(/^\d{1,20}$/), fc.mixedCase(ANY_UNIT))
  .map(([amount, unit]) => amount + unit)

// A whole amount of one unit that is still a safe count of bytes.
const WHOLE_AMOUNT_OF_UNIT = ANY_UNIT.chain(unit =>
  fc.tuple(fc.constant(unit), fc.integer({ min: 0, max: Math.floor(Number.MAX_SAFE_INTEGER / UNIT_BYTES[unit]!) })),
)

// Sizes, many of them whole multiples of a unit, which a plain range of integers would almost never give.
const SIZE = fc.oneof(
  fc.maxSafeNat(),
  WHOLE_AMOUNT_OF_UNIT.map(([unit, amount]) => amount * UNIT_BYTES[unit]!),
)

// What `formatBytes` writes for a size: the shortest exact text, in one of six lower-case units.
const CANONICAL = /^(0|[1-9]\d*)(b|kb|mb|gb|tb|pb)$/

function isByteSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

// Whether the parser takes the text for byte text: it reads it, or reads it and finds it too large.
function parses(text: string): boolean {
  try {
    parseBytes(text)
    return true
  } catch (error) {
    if (!(error instanceof ErrInvalidByteSize)) {
      throw error
    }

    return error.message.includes('out of range')
  }
}

// What a call comes to, a size or the message it threw, so two calls can be compared outcome for outcome.
function outcome(read: () => number): number | string {
  try {
    return read()
  } catch (error) {
    if (!(error instanceof ErrInvalidByteSize)) {
      throw error
    }

    return error.message
  }
}

describe('parseBytes (property)', () => {
  // `BYTES_PATTERN` is what configuration validates and `parseBytes` what then reads the value. Text the pattern
  // admits but the parser refuses as misspelt fails at bootstrap() as a decode error rather than a validation issue
  // on the field; text the parser reads but the pattern refuses can never be configured. Text close to the grammar is
  // where the two would part, so most candidates are grammatical text with one character added or taken away.
  const added = fc.constantFrom(' ', '\n', '.', '-', '+', '_', ',', 'e', 'i', 'I', 'b', 'B', 'K', 'x', '0', '１', '٣')
  const nearText = fc.oneof(
    BYTE_TEXT,
    // At either end, where a pattern or a parser missing an anchor would still match.
    fc.tuple(added, BYTE_TEXT).map(([before, text]) => before + text),
    fc.tuple(BYTE_TEXT, added).map(([text, after]) => text + after),
    fc.tuple(BYTE_TEXT, fc.nat(), added).map(([text, at, inserted]) => {
      const index = at % (text.length + 1)
      return text.slice(0, index) + inserted + text.slice(index)
    }),
    fc.tuple(BYTE_TEXT, fc.nat()).map(([text, at]) => {
      const index = at % text.length
      return text.slice(0, index) + text.slice(index + 1)
    }),
    fc.string(),
    fc.string({ unit: 'grapheme' }),
  )

  it.prop([nearText], { numRuns: 1_000 })('agrees with BYTES_PATTERN on every text', text => {
    expect(pattern.test(text)).toBe(parses(text))
  })

  it.prop([WHOLE_AMOUNT_OF_UNIT])(
    'scales a whole amount by its unit, up to the largest safe size',
    ([unit, amount]) => {
      expect(parseBytes(`${amount}${unit}`)).toBe(amount * UNIT_BYTES[unit]!)
    },
  )

  it.prop([
    WHOLE_AMOUNT_OF_UNIT.chain(([unit, amount]) => fc.tuple(fc.constant(amount), fc.mixedCase(fc.constant(unit)))),
  ])('reads a unit in any case', ([amount, unit]) => {
    expect(parseBytes(`${amount}${unit}`)).toBe(parseBytes(`${amount}${unit.toLowerCase()}`))
  })

  it.prop([WHOLE_AMOUNT_OF_UNIT, fc.nat({ max: 40 })])('ignores leading zeros', ([unit, amount], zeros) => {
    expect(parseBytes(`${'0'.repeat(zeros)}${amount}${unit}`)).toBe(amount * UNIT_BYTES[unit]!)
  })

  it.prop([BYTE_TEXT])('reads a size or refuses one past the largest safe size, nothing between', text => {
    const size = outcome(() => parseBytes(text))

    if (typeof size === 'number') {
      expect(isByteSize(size)).toBe(true)
    } else {
      expect(size).toContain('out of range')
    }
  })
})

describe('formatBytes (property)', () => {
  // What a log line or an error message prints, a reader may paste back into configuration.
  it.prop([SIZE])('writes text that reads back to the size', size => {
    expect(parseBytes(formatBytes(size))).toBe(size)
  })

  it.prop([SIZE])('writes canonical text BYTES_PATTERN admits', size => {
    const text = formatBytes(size)

    expect(text).toMatch(CANONICAL)
    expect(pattern.test(text)).toBe(true)
  })

  // A smaller unit than it needs would print `1024kb` for `1mb`.
  it.prop([SIZE])('writes the largest unit that holds the size exactly', size => {
    const [, amount, unit] = CANONICAL.exec(formatBytes(size))!

    if (size === 0) {
      expect(`${amount}${unit}`).toBe('0b')
    } else {
      expect(Number(amount) % 1024 !== 0 || unit === 'pb').toBe(true)
    }
  })

  it.prop([fc.oneof(fc.double(), fc.maxSafeInteger(), SIZE)])(
    'never throws, and writes what is not a size as JavaScript does',
    value => {
      const text = formatBytes(value)

      if (isByteSize(value)) {
        expect(text).toMatch(CANONICAL)
        // A size has one zero: `-0` reads back as `0`.
        expect(parseBytes(text)).toBe(value === 0 ? 0 : value)
      } else {
        expect(text).toBe(String(value))
      }
    },
  )
})

describe('bytes (property)', () => {
  // A third-party option reached through `bytes(...)` gets exactly the size a Caffeine option would.
  it.prop([fc.oneof(fc.double(), fc.maxSafeInteger(), SIZE)])(
    'passes a number through exactly when it is a whole number of bytes',
    value => {
      if (isByteSize(value)) {
        expect(bytes(value)).toBe(value)
      } else {
        expect(() => bytes(value)).toThrow(ErrInvalidByteSize)
      }
    },
  )

  it.prop([fc.oneof(BYTE_TEXT, fc.string())])('reads text exactly as parseBytes does', text => {
    expect(outcome(() => bytes(text))).toBe(outcome(() => parseBytes(text)))
  })
})
