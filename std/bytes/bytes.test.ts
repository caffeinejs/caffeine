import { describe, it, expect } from 'vitest'

import { BYTES_PATTERN, bytes, ErrInvalidByteSize } from './index.js'

// One row per unit, listing every spelling that must resolve to the same multiplier. Adding a unit means
// adding a row here and nothing else: every block below is driven by this table, so a unit added to the
// parser but missed in BYTES_PATTERN — or the reverse — fails.
const UNITS: ReadonlyArray<readonly [spellings: readonly string[], multiplier: number]> = [
  [['b', 'B'], 1],
  [['k', 'K', 'kb', 'KB', 'Kb', 'kB'], 1024],
  [['m', 'M', 'mb', 'MB', 'Mb', 'mB'], 1024 ** 2],
  [['g', 'G', 'gb', 'GB', 'Gb', 'gB'], 1024 ** 3],
  [['t', 'T', 'tb', 'TB', 'Tb', 'tB'], 1024 ** 4],
  [['p', 'P', 'pb', 'PB', 'Pb', 'pB'], 1024 ** 5],
]

// Strings outside the grammar. BYTES_PATTERN must reject each one, so a field typed `$t.Bytes` fails
// validation before `bytes` is ever called.
const OUTSIDE_GRAMMAR: readonly string[] = [
  '1KiB', // Kubernetes binary suffix
  '1Ki', // Kubernetes binary suffix, short
  '1 KB', // whitespace
  '1.5GB', // Compose has no decimals
  '1gb512mb', // compound segments
  '10x', // unknown unit
  '', // empty
  'kb', // unit with no amount
  '-1kb', // negative
  '1bb', // doubled suffix
  '+1kb', // signed
  '0x10', // hexadecimal
]

describe('bytes — units', () => {
  // Every prefix is 1024, not 1000. That is the Docker Compose reading, and it is the whole reason this
  // module rejects the Kubernetes spellings: `1k` cannot be both 1024 and 1000.
  it.each(UNITS)('%s multiply by %d', (spellings, multiplier) => {
    for (const spelling of spellings) {
      expect(bytes(`2${spelling}`)).toBe(2 * multiplier)
      expect(bytes(`0${spelling}`)).toBe(0)
    }
  })

  it('"1KB" → 1024', () => {
    expect(bytes('1KB')).toBe(1024)
  })

  it('"10mb" → 10485760', () => {
    expect(bytes('10mb')).toBe(10_485_760)
  })
})

describe('bytes — unitless', () => {
  it('reads a bare amount as bytes', () => {
    expect(bytes('1024')).toBe(1024)
    expect(bytes('0')).toBe(0)
  })

  it('passes a number through', () => {
    expect(bytes(1024)).toBe(1024)
    expect(bytes(0)).toBe(0)
    expect(bytes(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
  })

  // A size limit is a count of bytes, so a fraction or a negative is a mistake in the caller rather than
  // something to round or clamp.
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
    'rejects the number %p',
    value => {
      expect(() => bytes(value)).toThrow(ErrInvalidByteSize)
    },
  )
})

describe('bytes — rejects', () => {
  it.each(OUTSIDE_GRAMMAR)('rejects %o', value => {
    expect(() => bytes(value)).toThrow(ErrInvalidByteSize)
  })

  it('rejects an amount too large to hold exactly', () => {
    expect(() => bytes('9999pb')).toThrow(ErrInvalidByteSize)
  })

  it('reports the value and the grammar', () => {
    try {
      bytes('1KiB')
      expect.unreachable('bytes should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ErrInvalidByteSize)
      expect((error as ErrInvalidByteSize).name).toBe('ErrInvalidByteSize')
      expect((error as ErrInvalidByteSize).code).toBe('ERR_INVALID_BYTE_SIZE')
      expect((error as ErrInvalidByteSize).message).toContain('Cannot parse byte size "1KiB"')
      expect((error as ErrInvalidByteSize).message).toContain('b, kb, mb, gb, tb or pb')
    }
  })
})

describe('BYTES_PATTERN', () => {
  // The validation gate in front of `bytes` for a field typed `$t.Bytes`. The two must agree exactly:
  // a string the pattern admits but the parser throws on would surface as a decode failure instead of a
  // configuration error, and one the pattern rejects but the parser accepts is silently unreachable.
  const re = new RegExp(BYTES_PATTERN)

  it('matches every spelling the parser accepts', () => {
    for (const [spellings] of UNITS) {
      for (const spelling of spellings) {
        expect(re.test(`2${spelling}`)).toBe(true)
      }
    }

    expect(re.test('1024')).toBe(true)
  })

  it.each(OUTSIDE_GRAMMAR)('rejects %o', value => {
    expect(re.test(value)).toBe(false)
  })
})
