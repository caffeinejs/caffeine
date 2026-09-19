import { Injectable, type NamedToken, token } from '@caffeinejs/di'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { $t } from '../../schema/t.js'
import { createLive } from '../live.js'
import { freezeDeep } from '../tree.js'
import type { ConfigSnapshot, InferConfig, LiveConfig, ReadonlyConfig } from '../types.js'

const appConfigSchema = $t.Object({
  pricing: $t.Object({ margin: $t.Number({ default: 0.2 }), tiers: $t.Array($t.String()) }, { default: {} }),
})

type AppConfig = InferConfig<typeof appConfigSchema>

// An application names its configuration once and uses that name everywhere: in a token, in a constructor, in a
// function signature. These are compile-time assertions, so they pass by type-checking.
describe('the application config type', () => {
  it('is already read-only, so projecting it again changes nothing', () => {
    expectTypeOf<AppConfig>().toEqualTypeOf<{
      readonly pricing: { readonly margin: number; readonly tiers: readonly string[] }
    }>()
    expectTypeOf<ReadonlyConfig<AppConfig>>().toEqualTypeOf<AppConfig>()
    expectTypeOf<LiveConfig<AppConfig>>().toEqualTypeOf<AppConfig>()
    expectTypeOf<ConfigSnapshot<AppConfig>>().toEqualTypeOf<AppConfig>()
  })

  // Tokens are invariant in the type they carry, so the store's `LiveConfig<AppConfig>` and the application's
  // `token<AppConfig>` must be the very same type for a binding to type-check.
  it('round-trips through a token', () => {
    const kConfig = token<AppConfig>(Symbol('app.config'))

    expectTypeOf(kConfig).toEqualTypeOf<symbol & NamedToken<AppConfig>>()
    expectTypeOf<NamedToken<LiveConfig<AppConfig>>>().toEqualTypeOf<NamedToken<AppConfig>>()
  })

  it('types a constructor parameter the key injects', () => {
    const kConfig = token<AppConfig>(Symbol('app.config'))

    @Injectable([kConfig])
    class Pricing {
      constructor(private readonly config: AppConfig) {}

      quote(): number {
        return this.config.pricing.margin
      }
    }

    expect(Pricing).toBeDefined()
  })
})

// Arrays must be read-only from the outside, in the type system as much as at run time. `readonly (infer U)[]` is
// what makes these hold: `Array<infer U>` would miss a field already declared readonly, and an optional array
// would fall through as a mutable one.
describe('ReadonlyConfig array typing', () => {
  interface Shape {
    mutable: string[]
    already: readonly string[]
    optional?: string[]
    servers: { host: string }[]
    nested: { ports: number[] }
  }

  it('keeps every array shape read-only', () => {
    const config = createLive<Shape>(
      freezeDeep({
        mutable: ['a'],
        already: ['b'],
        optional: ['c'],
        servers: [{ host: 'h' }],
        nested: { ports: [1] },
      }),
    )

    const mutable: readonly string[] = config.mutable
    const already: readonly string[] = config.already
    const optional: readonly string[] | undefined = config.optional
    const nested: readonly number[] = config.nested.ports
    // Elements are projected too, so an object inside a read-only list is not handed back mutable.
    const host: string = config.servers[0].host

    expect([mutable, already, optional, nested, host]).toBeDefined()

    // @ts-expect-error an array field is read-only, so it has no `push`
    expect(() => config.mutable.push('x')).toThrow(TypeError)
    // @ts-expect-error including the optional one
    expect(() => config.optional?.push('x')).toThrow(TypeError)
    expect(() => {
      // @ts-expect-error and elements are read-only, not just the list holding them
      config.servers[0].host = 'other'
    }).toThrow(TypeError)
  })
})
