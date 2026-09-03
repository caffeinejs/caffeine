import { describe, it, expect } from 'vitest'

import { ErrMissingInjectionKey } from '../errors.js'
import { $i } from '../injection.js'
import { BuiltInStages } from '../injection_resolver.js'
import { token } from '../key.js'

// Shape only. What each chain resolves to is covered by injection_composition.test.ts, and the compiler's own
// rules — terminal last, one terminal per chain — by injection_chain.test.ts.

describe('$i.provide()', function () {
  it('appends the provider stage to a key', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.provide(k)
    expect(result).toEqual({ key: k, stages: [{ name: BuiltInStages.PROVIDER }] })
  })

  it('includes optional flag when composed with $i.optional()', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.optional($i.provide(k))
    expect(result).toEqual({ key: k, optional: true, stages: [{ name: BuiltInStages.PROVIDER }] })
  })

  it('throws ErrMissingInjectionKey when key is null', function () {
    expect(() => $i.provide(null as never)).toThrow(ErrMissingInjectionKey)
  })
})

describe('$i.allOf($i.provide())', function () {
  it('appends the array terminal after the provider stage', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.allOf($i.provide(k))
    expect(result).toEqual({
      key: k,
      stages: [{ name: BuiltInStages.PROVIDER }, { name: BuiltInStages.MANY }],
    })
  })

  it('includes optional flag when composed with $i.optional()', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.optional($i.allOf($i.provide(k)))
    expect(result).toEqual({
      key: k,
      optional: true,
      stages: [{ name: BuiltInStages.PROVIDER }, { name: BuiltInStages.MANY }],
    })
  })
})

describe('$i.allOf()', function () {
  it('names the array terminal for a key', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.allOf(k)
    expect(result).toEqual({ key: k, stages: [{ name: BuiltInStages.MANY }] })
  })

  it('accepts a descriptor and appends the array terminal', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.allOf($i.optional(k))
    expect(result).toEqual({ key: k, optional: true, stages: [{ name: BuiltInStages.MANY }] })
  })

  // Two terminals: an array of every binding and a map of them are different requests. The chain reports the
  // conflict by name when it compiles; previously the map silently won and the type said otherwise.
  it('accumulates a conflicting terminal rather than dropping one', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.allOf($i.mapped(k))
    expect(result).toEqual({ key: k, stages: [{ name: BuiltInStages.MAP }, { name: BuiltInStages.MANY }] })
  })

  it('does not repeat the array terminal it already named', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    expect($i.allOf($i.allOf(k))).toEqual({ key: k, stages: [{ name: BuiltInStages.MANY }] })
  })

  // A descriptor literal is not an injection to the compiler any more, so this only guards JS callers.
  it('throws ErrMissingInjectionKey when descriptor has no valid key', function () {
    expect(() => $i.allOf({ stages: [] } as never)).toThrow(ErrMissingInjectionKey)
  })
})

describe('$i.ordered()', function () {
  it('sorts before collecting', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    expect($i.ordered(k)).toEqual({
      key: k,
      stages: [{ name: BuiltInStages.SORT }, { name: BuiltInStages.MANY }],
    })
  })

  it('keeps the provider stage it was composed over', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    expect($i.ordered($i.provide(k))).toEqual({
      key: k,
      stages: [{ name: BuiltInStages.PROVIDER }, { name: BuiltInStages.SORT }, { name: BuiltInStages.MANY }],
    })
  })

  it('adds only the sort when the inner descriptor already collects', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    expect($i.ordered($i.allOf(k))).toEqual({
      key: k,
      stages: [{ name: BuiltInStages.MANY }, { name: BuiltInStages.SORT }],
    })
  })
})

describe('$i.optional()', function () {
  it('returns descriptor with optional: true for a key', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.optional(k)

    expect(result).toEqual({ key: k, optional: true, stages: [] })
  })
})

describe('$i.compose()', function () {
  it('accumulates the stages of every function it composes', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.compose(k, $i.optional, $i.allOf)
    expect(result).toEqual({ key: k, optional: true, stages: [{ name: BuiltInStages.MANY }] })
  })

  // Composing two terminals is accepted here and refused when the chain compiles, which is where both names can
  // be reported.
  it('accumulates conflicting terminals rather than dropping one', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    const result = $i.compose(k, $i.optional, $i.allOf, $i.mapped)
    expect(result).toEqual({
      key: k,
      optional: true,
      stages: [{ name: BuiltInStages.MANY }, { name: BuiltInStages.MAP }],
    })
  })

  it('applies to different keys independently', function () {
    const k1 = token<Record<string, unknown>>(Symbol.for('a'))
    const k2 = token<Record<string, unknown>>(Symbol.for('b'))
    expect($i.compose(k1, $i.optional, $i.allOf)).toEqual({
      key: k1,
      optional: true,
      stages: [{ name: BuiltInStages.MANY }],
    })
    expect($i.compose(k2, $i.optional, $i.allOf)).toEqual({
      key: k2,
      optional: true,
      stages: [{ name: BuiltInStages.MANY }],
    })
  })

  it('with a single function behaves like that function', function () {
    const k = token<Record<string, unknown>>(Symbol.for('test'))
    expect($i.compose(k, $i.optional)).toEqual($i.optional(k))
  })
})
