import { describe, it, afterEach, expect } from 'vitest'
import { CaffeineIoC } from '../container.js'
import { ErrNoResolutionForKey, ErrResolverAlreadyRegistered, ErrUnknownResolver } from '../errors.js'
import {
  BuiltInResolvers,
  bindResolver,
  hasResolver,
  InjectionResolverFactory,
  unbindResolver,
} from '../injection_resolver.js'
import { $i } from '../injection.js'
import { standardFactory } from '../internal/core/resolver/index.js'

const sentinel = { value: 42 }
const kTestResolver = Symbol('test-resolver')

class CustomConsumer {
  constructor(readonly dep: typeof sentinel) {}
}

class UnknownResolverConsumer {
  constructor(readonly dep: unknown) {}
}

afterEach(() => {
  if (hasResolver(kTestResolver)) {
    unbindResolver(kTestResolver)
  }
})

describe('hasResolver()', function () {
  it('returns true for built-in resolvers', function () {
    expect(hasResolver(BuiltInResolvers.DEFAULT))
      .toBe(true)
    expect(hasResolver(BuiltInResolvers.MAP))
      .toBe(true)
    expect(hasResolver(BuiltInResolvers.DEFER))
      .toBe(true)
    expect(hasResolver(BuiltInResolvers.OBJECT))
      .toBe(true)
  })

  it('returns false for unknown resolver', function () {
    expect(hasResolver(Symbol('unknown')))
      .toBe(false)
  })
})

describe('bindResolver()', function () {
  it('registers a custom resolver', function () {
    const factory: InjectionResolverFactory = () => () => undefined
    bindResolver(kTestResolver, factory)
    expect(hasResolver(kTestResolver))
      .toBe(true)
  })

  it('throws ErrResolverAlreadyRegistered on duplicate name', function () {
    const factory: InjectionResolverFactory = () => () => undefined
    bindResolver(kTestResolver, factory)
    expect(() => bindResolver(kTestResolver, factory))
      .toThrow(ErrResolverAlreadyRegistered)
  })
})

describe('unbindResolver()', function () {
  it('removes a registered resolver', function () {
    bindResolver(kTestResolver, () => () => undefined)
    unbindResolver(kTestResolver)
    expect(hasResolver(kTestResolver))
      .toBe(false)
  })
})

describe('providerResolverFactory — missing binding (L-2)', function () {
  it('should throw ErrNoResolutionForKey at init() time when the injected key is not registered', async function () {
    const kMissing = Symbol('missing-l2')

    class Consumer {
      constructor(readonly dep: unknown) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Consumer)
      .toSelf([$i.provide(kMissing)])

    await expect(di.init()).rejects.toBeInstanceOf(ErrNoResolutionForKey)
  })

  it('should return a Provider whose get() is undefined when $i.provide() target is optional and missing', async function () {
    const kMissing = Symbol('missing-optional-l2')

    class OptConsumer {
      constructor(readonly dep: unknown) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(OptConsumer)
      .toSelf([{ key: kMissing, optional: true, resolver: BuiltInResolvers.PROVIDER }])
    await di.init()

    const inst = di.get(OptConsumer)
    expect(inst.dep)
      .toBeDefined()
    expect((inst.dep as { get: () => unknown }).get())
      .toBeUndefined()
  })
})

describe('defaultResolverFactory', function () {
  it('should return undefined for optional missing dependencies', function () {
    const di = new CaffeineIoC({ decorators: false })
    const kMissing = Symbol('resolver-missing-optional')

    const resolver = standardFactory({
      container: di,
      descriptor: $i.optional(kMissing),
      key: 'consumer',
      kind: 'constructor',
      member: 'miss',
      index: 0,
    })

    expect(resolver())
      .toBeUndefined()
  })

  it('should resolve all bindings for multiple injection', async function () {
    const kShared = Symbol('resolver-shared-multi')
    const di = new CaffeineIoC({ decorators: false })

    di.bind('a')
      .toValue('one')
      .names(kShared)
    di.bind('b')
      .toValue('two')
      .names(kShared)
    await di.init()

    const resolver = standardFactory({
      container: di,
      descriptor: $i.allOf(kShared),
      key: 'consumer',
      kind: 'constructor',
      member: 'm',
      index: 0,
    })

    expect(resolver())
      .toEqual(['one', 'two'])
  })
})

describe('custom resolver end-to-end', function () {
  it('resolves using a registered factory', async function () {
    bindResolver(kTestResolver, () => () => sentinel)

    const di = new CaffeineIoC({ decorators: false })
    di.bind(CustomConsumer)
      .toSelf([{ resolver: kTestResolver }])
    await di.init()

    expect(di.get(CustomConsumer)!.dep)
      .toBe(sentinel)
  })

  it('throws ErrUnknownResolver when resolver name is not registered', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(UnknownResolverConsumer)
      .toSelf([{ resolver: Symbol('no-such-resolver') }])

    await expect(di.init()).rejects.toBeInstanceOf(ErrUnknownResolver)
  })
})
