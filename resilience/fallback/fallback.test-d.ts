import { describe, expectTypeOf, it } from 'vitest'

import type { Operation } from '../policy.js'
import { fallback } from './fallback.js'

interface Stock {
  readonly id: string
  readonly count: number
}

interface CachedStock extends Stock {
  readonly stale: true
}

declare const getStock: Operation<Stock, string>

describe('fallback types', () => {
  it('widens the result by what the handler answers with, value or promise', () => {
    const stale = fallback((): CachedStock => ({ id: '42', count: 0, stale: true }))

    expectTypeOf(stale.wrap(getStock)).toEqualTypeOf<Operation<Stock | CachedStock, string>>()
    expectTypeOf(fallback(async () => null).wrap(getStock)).toEqualTypeOf<Operation<Stock | null, string>>()
  })

  it('hands the handler the error and the input as unknown', () => {
    fallback((error, input) => {
      expectTypeOf(error).toBeUnknown()
      expectTypeOf(input).toBeUnknown()
      return 0
    })
  })

  it('takes a predicate or a list of error classes as on', () => {
    fallback(() => 0, { on: error => error instanceof RangeError })
    fallback(() => 0, { on: [RangeError, TypeError] })
    // @ts-expect-error -- an entry of on is an error class, not an instance
    fallback(() => 0, { on: [new RangeError()] })
  })
})
