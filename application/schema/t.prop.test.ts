import { fc, it } from '@fast-check/vitest'
import { Value } from '@sinclair/typebox/value'
import { describe, expect } from 'vitest'

import { $t } from './t.js'

describe('$t.Bytes (property)', () => {
  // Sizes, many of them whole multiples of a unit, which a plain range of integers would almost never give.
  const size = fc.oneof(
    fc.maxSafeNat(),
    fc
      .constantFrom(1, 1024, 1024 ** 2, 1024 ** 3, 1024 ** 4, 1024 ** 5)
      .chain(unit => fc.integer({ min: 0, max: Math.floor(Number.MAX_SAFE_INTEGER / unit) }).map(n => n * unit)),
  )

  // A configuration written back out, from a resolved tree, must read in to the same sizes.
  it.prop([size])('decodes what it encodes, for every size', n => {
    expect(Value.Decode($t.Bytes(), Value.Encode($t.Bytes(), n))).toBe(n)
  })
})
