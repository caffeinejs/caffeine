import { describe, expectTypeOf, it } from 'vitest'

import { circuitBreaker } from './circuitbreaker/circuitbreaker.js'
import { compose, decorate, run } from './compose.js'
import { fallback } from './fallback/fallback.js'
import type { Operation, Policy, Recovery, Wrapper } from './policy.js'
import { retry } from './retry/retry.js'

interface Stock {
  readonly count: number
}

const CACHED = { cached: true } as const
type Cached = typeof CACHED

declare function fetchStock(id: string, signal?: AbortSignal): Promise<Stock>

const timing: Policy = op => async (ctx, input) => op(ctx, input)

describe('compose types', () => {
  it('is a policy when every layer is one, functions and instances mixed', () => {
    expectTypeOf(compose(retry({ name: 'x' }), circuitBreaker({ name: 'x' }), timing)).toEqualTypeOf<Policy>()
    expectTypeOf(compose()).toEqualTypeOf<Policy>()
  })

  it('widens the result by what an outermost fallback answers with', () => {
    expectTypeOf(
      compose(
        fallback(() => CACHED),
        circuitBreaker({ name: 'x' }),
        timing,
      ),
    ).toEqualTypeOf<Recovery<Cached>>()
    const recovery: Recovery<Cached> = op => (ctx, input) => op(ctx, input).catch(() => CACHED)
    expectTypeOf(compose(recovery, timing)).toEqualTypeOf<Recovery<Cached>>()
  })

  it('keeps the operation’s result and input types', () => {
    const op: Operation<Stock, string> = async () => ({ count: 1 })
    expectTypeOf(compose(timing)(op)).toEqualTypeOf<Operation<Stock, string>>()
    expectTypeOf(compose(fallback(() => CACHED))(op)).toEqualTypeOf<Operation<Stock | Cached, string>>()
  })

  it('takes an operation without input as one called with the context alone', () => {
    const guarded = circuitBreaker({ name: 'x' }).wrap(async () => 1)
    expectTypeOf(guarded).toEqualTypeOf<Operation<number>>()
    expectTypeOf(compose(timing)(async () => 1)).toEqualTypeOf<Operation<number>>()
    void guarded({ signal: undefined })
  })

  it('refuses a fallback anywhere but outermost', () => {
    const inner = fallback(() => 1)
    // @ts-expect-error -- a fallback widens the result, so only the outermost layer may be one
    compose(timing, inner)
  })

  it('refuses a recovery where a policy is expected', () => {
    // @ts-expect-error -- a recovery is not a plain policy
    const policy: Policy = compose(fallback(() => CACHED))
    // @ts-expect-error -- a fallback is not a plain wrapper
    const wrapper: Wrapper = fallback(() => 1)
    void [policy, wrapper]
  })
})

describe('decorate types', () => {
  it('keeps the function’s signature', () => {
    expectTypeOf(decorate(timing, fetchStock)).toEqualTypeOf<(id: string, signal?: AbortSignal) => Promise<Stock>>()
    expectTypeOf(decorate(circuitBreaker({ name: 'x' }), fetchStock)).toEqualTypeOf<
      (id: string, signal?: AbortSignal) => Promise<Stock>
    >()
  })

  it('widens the result by what a fallback answers with, as an instance, a function or composed', () => {
    type Widened = (id: string, signal?: AbortSignal) => Promise<Stock | Cached>
    const recovery: Recovery<Cached> = op => (ctx, input) => op(ctx, input).catch(() => CACHED)

    expectTypeOf(
      decorate(
        fallback(() => CACHED),
        fetchStock,
      ),
    ).toEqualTypeOf<Widened>()
    expectTypeOf(decorate(recovery, fetchStock)).toEqualTypeOf<Widened>()
    expectTypeOf(
      decorate(
        compose(
          fallback(() => CACHED),
          timing,
        ),
        fetchStock,
      ),
    ).toEqualTypeOf<Widened>()
  })
})

describe('run types', () => {
  it('resolves to the operation’s result', () => {
    expectTypeOf(run(async () => 1)).toEqualTypeOf<Promise<number>>()
  })
})
