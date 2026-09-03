import { describe, expectTypeOf, it } from 'vitest'

import { $i, type InjectedOf } from '../injection.js'
import { token } from '../key.js'
import type { Provider } from '../provider.js'

abstract class Plugin {
  abstract id(): string
}

class Service {}

const kMovie = token<{ title: string }>('movie')

// The pairing that was missing when `$i.object` typed one thing and resolved another: every case asserted here has
// a counterpart in object_injection.test.ts resolving the same spec, so the two cannot drift apart unnoticed.
describe('InjectedOf', function () {
  it('gives each helper the result that helper documents', function () {
    expectTypeOf<InjectedOf<{ x: ReturnType<typeof $i.provide<typeof Service>> }>['x']>().toEqualTypeOf<
      Provider<Service>
    >()
    expectTypeOf<InjectedOf<{ x: ReturnType<typeof $i.allOf<typeof Plugin>> }>['x']>().toEqualTypeOf<Plugin[]>()
    expectTypeOf<InjectedOf<{ x: ReturnType<typeof $i.ordered<typeof Plugin>> }>['x']>().toEqualTypeOf<Plugin[]>()
    expectTypeOf<InjectedOf<{ x: ReturnType<typeof $i.optional<typeof Service>> }>['x']>().toEqualTypeOf<
      Service | undefined
    >()
    expectTypeOf<InjectedOf<{ x: ReturnType<typeof $i.mapped<typeof kMovie>> }>['x']>().toEqualTypeOf<
      Map<string, { title: string }>
    >()
    expectTypeOf<InjectedOf<{ x: ReturnType<typeof $i.defer<typeof Service>> }>['x']>().toEqualTypeOf<Service>()
  })

  it('gives a constant the type it was given', function () {
    const spec = { label: $i.just('pets'), count: $i.just(3) }

    expectTypeOf<InjectedOf<typeof spec>['label']>().toEqualTypeOf<string>()
    expectTypeOf<InjectedOf<typeof spec>['count']>().toEqualTypeOf<number>()
  })

  it('gives a raw key its instance, in every form a key takes', function () {
    expectTypeOf<InjectedOf<{ x: typeof Service }>['x']>().toEqualTypeOf<Service>()
    expectTypeOf<InjectedOf<{ x: typeof kMovie }>['x']>().toEqualTypeOf<{ title: string }>()
  })

  it('recurses into a nested spec', function () {
    const spec = { outer: { svc: Service, label: $i.just('inner') } }

    expectTypeOf<InjectedOf<typeof spec>['outer']['svc']>().toEqualTypeOf<Service>()
    expectTypeOf<InjectedOf<typeof spec>['outer']['label']>().toEqualTypeOf<string>()
  })

  it('reads a hand-written descriptor literal as a bag, the way the runtime does', function () {
    expectTypeOf<InjectedOf<{ cfg: { key: typeof Service } }>['cfg']['key']>().toEqualTypeOf<Service>()
  })
})
