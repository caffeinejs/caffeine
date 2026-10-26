import { describe, expectTypeOf, it } from 'vitest'

import { fallback } from './fallback.js'

interface Stock {
  readonly id: string
  readonly count: number
}

interface CachedStock extends Stock {
  readonly stale: true
}

describe('fallback types', () => {
  it('resolves to the call’s type or the handler’s', () => {
    const stale = fallback({ name: 'inventory' })
    const call = Promise.resolve<Stock>({ id: '42', count: 1 })

    expectTypeOf(stale.recover(call, (): CachedStock => ({ id: '42', count: 0, stale: true }))).toEqualTypeOf<
      Promise<Stock | CachedStock>
    >()
    expectTypeOf(stale.recover(call, async () => null)).toEqualTypeOf<Promise<Stock | null>>()
  })

  it('hands the handler the error as unknown', () => {
    const stale = fallback({ name: 'inventory' })

    void stale.recover(Promise.resolve(1), error => {
      expectTypeOf(error).toBeUnknown()
      return 0
    })
  })

  it('takes a signal last, optionally', () => {
    const stale = fallback({ name: 'inventory' })

    void stale.recover(Promise.resolve(1), () => 0, new AbortController().signal)
    // @ts-expect-error -- the signal is an AbortSignal, not a boolean
    void stale.recover(Promise.resolve(1), () => 0, true)
  })
})
