import { describe, expectTypeOf, it } from 'vitest'

import { $i, type InjectedOf, type InjectionDescriptor, type ResolveInjection } from '../injection.js'
import { token } from '../key.js'
import type { Provider } from '../provider.js'

class UserService {}
class OrderService {}
class AppConfig {}

interface Movie {
  title: string
}

describe('ResolveInjection', function () {
  it('resolves class tokens to the instance type', function () {
    expectTypeOf<ResolveInjection<typeof UserService>>().toEqualTypeOf<UserService>()
  })

  it('resolves named tokens to the branded type argument', function () {
    const kMovie = token<Movie>('movie')
    expectTypeOf<ResolveInjection<typeof kMovie>>().toEqualTypeOf<Movie>()
  })

  it('resolves descriptors to the encoded result type', function () {
    const optionalOrder = $i.optional(OrderService)
    const allUsers = $i.allOf(UserService)
    const provided = $i.provide(UserService)

    expectTypeOf<ResolveInjection<typeof optionalOrder>>().toEqualTypeOf<OrderService | undefined>()
    expectTypeOf<ResolveInjection<typeof allUsers>>().toEqualTypeOf<UserService[]>()
    expectTypeOf<ResolveInjection<typeof provided>>().toEqualTypeOf<Provider<UserService>>()
  })

  // Composing over `$i.provide` keeps the wrapper outermost, matching the single `Provider` the resolver builds.
  it('keeps the provider on the outside when composed', function () {
    const allProvided = $i.allOf($i.provide(UserService))
    const optionalProvided = $i.optional($i.provide(UserService))

    expectTypeOf<ResolveInjection<typeof allProvided>>().toEqualTypeOf<Provider<UserService[]>>()
    expectTypeOf<ResolveInjection<typeof optionalProvided>>().toEqualTypeOf<Provider<UserService | undefined>>()
  })
})

describe('InjectedOf', function () {
  it('maps class tokens, named tokens, optional, allOf, and provide', function () {
    const kMovie = token<Movie>('movie')
    const spec = {
      us: UserService,
      os: $i.optional(OrderService),
      validators: $i.allOf(UserService),
      movies: $i.mapped(kMovie),
      sender: $i.provide(UserService),
      movie: kMovie,
    }

    expectTypeOf<InjectedOf<typeof spec>>().toEqualTypeOf<{
      us: UserService
      os: OrderService | undefined
      validators: UserService[]
      movies: Map<string, Movie>
      sender: Provider<UserService>
      movie: Movie
    }>()
  })

  it('recurses into nested specs', function () {
    const spec = {
      services: {
        user: UserService,
        order: $i.optional(OrderService),
      },
      config: AppConfig,
    }

    expectTypeOf<InjectedOf<typeof spec>>().toEqualTypeOf<{
      services: { user: UserService; order: OrderService | undefined }
      config: AppConfig
    }>()
  })

  // Only a value an `$i` helper produced is a descriptor. A literal that merely looks like one is a nested bag,
  // here and at run time alike — which is the point: the two cannot disagree about it any more.
  it('treats a nested object with a key field as a bag, not a descriptor', function () {
    const spec = {
      wrapped: { key: UserService },
    }

    expectTypeOf<InjectedOf<typeof spec>>().toEqualTypeOf<{ wrapped: { key: UserService } }>()
  })

  it('maps just, defer, and ordered helpers', function () {
    const spec = {
      msg: $i.just('hello' as const),
      deferred: $i.defer(() => UserService),
      ordered: $i.ordered(OrderService),
    }

    expectTypeOf<InjectedOf<typeof spec>>().toEqualTypeOf<{
      msg: 'hello'
      deferred: UserService
      ordered: OrderService[]
    }>()
  })
})

describe('$i.object()', function () {
  it('returns a descriptor parameterized with InjectedOf<S>', function () {
    const spec = {
      us: UserService,
      os: $i.optional(OrderService),
    }
    const desc = $i.object(spec)

    type Bag = typeof desc extends InjectionDescriptor<infer T> ? T : never
    expectTypeOf<Bag>().toEqualTypeOf<{ us: UserService; os: OrderService | undefined }>()
    expectTypeOf<Bag>().toEqualTypeOf<InjectedOf<typeof spec>>()
  })
})
