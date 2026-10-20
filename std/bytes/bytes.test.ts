import { describe, it, expect } from 'vitest'

import {
  Byte,
  bytes,
  BYTES_PATTERN,
  ErrInvalidByteSize,
  formatBytes,
  GiB,
  KiB,
  MiB,
  parseBytes,
  PiB,
  TiB,
} from './index.js'

const pattern = new RegExp(BYTES_PATTERN)

// Every spelling of each unit. Text is binary throughout, the Docker Compose reading: `1k` is 1024, which is why the
// Kubernetes spellings, where `1k` is 1000 and 1024 is `1Ki`, are refused. The sizes are written out rather than
// taken from the constants, so a wrong constant cannot agree with a wrong parser.
const UNITS: ReadonlyArray<readonly [spellings: readonly string[], size: number]> = [
  [['', 'b', 'B'], 1],
  [['k', 'K', 'kb', 'KB', 'Kb', 'kB'], 1024],
  [['m', 'M', 'mb', 'MB', 'Mb', 'mB'], 1024 ** 2],
  [['g', 'G', 'gb', 'GB', 'Gb', 'gB'], 1024 ** 3],
  [['t', 'T', 'tb', 'TB', 'Tb', 'tB'], 1024 ** 4],
  [['p', 'P', 'pb', 'PB', 'Pb', 'pB'], 1024 ** 5],
]

// The largest amount of each unit that is still a safe integer of bytes, and the first amount past it: 2^53 bytes,
// one more than `Number.MAX_SAFE_INTEGER`.
const BOUNDS: ReadonlyArray<readonly [largest: string, size: number, refused: string]> = [
  ['9007199254740991', 2 ** 53 - 1, '9007199254740992'],
  ['9007199254740991b', 2 ** 53 - 1, '9007199254740992b'],
  ['8796093022207kb', 2 ** 53 - 2 ** 10, '8796093022208kb'],
  ['8589934591mb', 2 ** 53 - 2 ** 20, '8589934592mb'],
  ['8388607gb', 2 ** 53 - 2 ** 30, '8388608gb'],
  ['8191tb', 2 ** 53 - 2 ** 40, '8192tb'],
  ['7pb', 2 ** 53 - 2 ** 50, '8pb'],
]

// In the grammar. Every row is checked against the parser and the pattern alike: the pattern is what configuration
// validates, so text it admits must read, and to this size.
const VALID: ReadonlyArray<readonly [text: string, size: number]> = [
  ['0', 0],
  ['0b', 0],
  ['0pb', 0],
  ['1', 1],
  ['1024', 1024],
  ['1b', 1],
  ['1KB', 1024],
  ['512kb', 524_288],
  ['10mb', 10_485_760],
  ['1Gb', 1_073_741_824],
  ['2g', 2_147_483_648],
  ['3T', 3_298_534_883_328],
  ['1pb', 1_125_899_906_842_624],
  ['007kb', 7168],
  // Leading zeros are not significant, however many there are.
  [`${'0'.repeat(400)}1kb`, 1024],
  ...BOUNDS.map(([text, size]) => [text, size] as const),
]

// Outside the grammar. The parser throws for each and the pattern refuses each, so a misspelt limit fails rather than
// reaching a server as some other size.
const INVALID: readonly string[] = [
  '',
  'b', // a unit with no amount
  'kb',
  '1KiB', // Kubernetes binary suffix
  '1Ki',
  '1MiB',
  '1Mi',
  '1 KB', // whitespace
  ' 1kb',
  '1kb ',
  '1kb\n',
  '\n1kb',
  '1.5GB', // Compose has no fractions
  '.5kb',
  '1.kb',
  '1gb512mb', // one amount, one unit
  '10x', // unknown unit
  '-1kb', // signed
  '+1kb',
  '-0',
  '1bb', // doubled suffix
  '1kbb',
  '1e3', // exponent
  '1_024', // separator
  '1,024',
  '0x10', // hexadecimal
  '１kb', // full-width digit
  '٣kb', // Arabic-Indic digit
  'constructor', // a unit is not looked up on an object's prototype
  '1constructor',
]

// In the grammar but past the largest safe size: the parser refuses each, and the pattern, which cannot hold a bound,
// admits each. Configuration reports the parser's refusal as a validation issue on the field.
const OUT_OF_RANGE: readonly string[] = [
  ...BOUNDS.map(([, , text]) => text),
  '9999pb',
  '9'.repeat(400),
  `${'9'.repeat(400)}pb`,
]

describe('parseBytes', () => {
  it.each(VALID)('reads %o', (text, size) => {
    expect(parseBytes(text)).toBe(size)
  })

  it.each(INVALID)('refuses %o', text => {
    expect(() => parseBytes(text)).toThrow(ErrInvalidByteSize)
  })

  it.each(OUT_OF_RANGE)('refuses %o, past the largest safe size', text => {
    expect(() => parseBytes(text)).toThrow(`Cannot parse byte size "${text}": out of range`)
  })

  it('says what is wrong', () => {
    expect(() => parseBytes('1KiB')).toThrow(
      'Cannot parse byte size "1KiB": expected an integer optionally followed by b, kb, mb, gb, tb or pb',
    )
    expect(() => parseBytes('8pb')).toThrow(
      'Cannot parse byte size "8pb": out of range: a byte size is at most 9007199254740991 bytes, one under 8pb',
    )
  })

  it('reports the value and the grammar', () => {
    try {
      parseBytes('lots')
      expect.unreachable('parseBytes should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ErrInvalidByteSize)
      expect((error as ErrInvalidByteSize).name).toBe('ErrInvalidByteSize')
      expect((error as ErrInvalidByteSize).code).toBe('ERR_INVALID_BYTE_SIZE')
      expect((error as ErrInvalidByteSize).message).toContain('Cannot parse byte size "lots"')
      expect((error as ErrInvalidByteSize).message).toContain('b, kb, mb, gb, tb or pb')
    }
  })

  it('gives up on a long run of digits without retrying at every digit', () => {
    const text = `${'9'.repeat(100_000)}x`
    const started = performance.now()

    expect(() => parseBytes(text)).toThrow(ErrInvalidByteSize)
    expect(pattern.test(text)).toBe(false)
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe('BYTES_PATTERN', () => {
  it.each(VALID)('admits %o', text => {
    expect(pattern.test(text)).toBe(true)
  })

  it.each(INVALID)('refuses %o', text => {
    expect(pattern.test(text)).toBe(false)
  })

  it.each(OUT_OF_RANGE)('admits %o, which only the parser refuses', text => {
    expect(pattern.test(text)).toBe(true)
  })
})

describe('bytes', () => {
  it.each(VALID)('reads the text %o as parseBytes does', (text, size) => {
    expect(bytes(text)).toBe(size)
  })

  it.each([...INVALID, ...OUT_OF_RANGE])('refuses the text %o', text => {
    expect(() => bytes(text)).toThrow(ErrInvalidByteSize)
  })

  it('reads the text a person writes as the constant code writes', () => {
    expect(bytes('1Gb')).toBe(1 * GiB)
    expect(bytes('512kb')).toBe(512 * KiB)
    expect(bytes('10MB')).toBe(10 * MiB)
  })

  it.each([0, -0, 1, 1 * MiB, Number.MAX_SAFE_INTEGER])('passes the number %o through, as a count of bytes', size => {
    expect(bytes(size)).toBe(size)
  })

  // A size is a count of bytes: a fraction or a negative is a mistake in the caller, not something to round or clamp,
  // and a size past `Number.MAX_SAFE_INTEGER` cannot be counted exactly.
  it.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 2,
    1e300,
  ])('refuses the number %o', value => {
    expect(() => bytes(value)).toThrow(
      `Cannot parse byte size "${value}": expected a whole number of bytes from 0 to 9007199254740991`,
    )
  })
})

describe('units', () => {
  it('count bytes, each 1024 of the one before', () => {
    expect([Byte, KiB, MiB, GiB, TiB, PiB]).toEqual([
      1, 1_024, 1_048_576, 1_073_741_824, 1_099_511_627_776, 1_125_899_906_842_624,
    ])
    expect([KiB / Byte, MiB / KiB, GiB / MiB, TiB / GiB, PiB / TiB]).toEqual([1024, 1024, 1024, 1024, 1024])
  })

  it.each(UNITS)('%j read as %d bytes, in any case', (spellings, size) => {
    for (const spelling of spellings) {
      expect(parseBytes(`3${spelling}`)).toBe(3 * size)
      expect(parseBytes(`0${spelling}`)).toBe(0)
    }
  })

  // What code writes and what configuration writes are the same size.
  it.each([
    [Byte, 'b'],
    [KiB, 'kb'],
    [MiB, 'mb'],
    [GiB, 'gb'],
    [TiB, 'tb'],
    [PiB, 'pb'],
  ])('%d is the size of one %s', (unit, spelling) => {
    expect(parseBytes(`5${spelling}`)).toBe(5 * unit)
  })
})

// The text is what an error message shows a reader, who may paste it back into configuration.
const FORMATTED: ReadonlyArray<readonly [size: number, text: string]> = [
  [0, '0b'],
  [1, '1b'],
  [1023, '1023b'],
  [1024, '1kb'],
  [1536, '1536b'],
  [2048, '2kb'],
  [1_047_552, '1023kb'],
  [1_048_576, '1mb'],
  [1_048_577, '1048577b'],
  [10_485_760, '10mb'],
  [1_073_741_824, '1gb'],
  [1_099_511_627_776, '1tb'],
  [1_125_899_906_842_624, '1pb'],
  [2 ** 53 - 2 ** 50, '7pb'],
  [2 ** 53 - 2 ** 40, '8191tb'],
  [Number.MAX_SAFE_INTEGER, '9007199254740991b'],
]

describe('formatBytes', () => {
  it.each(FORMATTED)('writes %d as %o', (size, text) => {
    expect(formatBytes(size)).toBe(text)
  })

  it.each(FORMATTED)('writes %d so that it reads back', size => {
    expect(parseBytes(formatBytes(size))).toBe(size)
  })

  it('writes -0 as zero', () => {
    expect(formatBytes(-0)).toBe('0b')
  })

  // It is the formatter of error messages, which must not throw on the bad value they describe.
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 53, 1e300])(
    'writes %o, which is not a size, as JavaScript does',
    value => {
      expect(formatBytes(value)).toBe(String(value))
    },
  )
})
