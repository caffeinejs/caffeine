import { describe, it, afterEach, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import {
  ErrConflictingInjectionStages,
  ErrInjectionStageAlreadyRegistered,
  ErrNoResolutionForKey,
  ErrResolverAlreadyRegistered,
  ErrUnknownResolver,
} from '../errors.js'
import { $i } from '../injection.js'
import {
  BuiltInStages,
  bindResolver,
  hasResolver,
  hasStage,
  InjectionMiddleware,
  InjectionResolverFactory,
  registerStage,
  unbindResolver,
  unregisterStage,
} from '../injection_resolver.js'
import { compileChain } from '../internal/core/resolver/index.js'
import { token } from '../key.js'

const sentinel = { value: 42 }
const kTestResolver = Symbol('test-resolver')

class CustomConsumer {
  constructor(readonly dep: typeof sentinel) {}
}

class UnknownResolverConsumer {
  constructor(readonly dep: unknown) {}
}

const kTestStage = Symbol('test-stage')

afterEach(() => {
  if (hasResolver(kTestResolver)) {
    unbindResolver(kTestResolver)
  }
  if (hasStage(kTestStage)) {
    unregisterStage(kTestStage)
  }
})

describe('hasStage()', function () {
  it('returns true for built-in stages', function () {
    expect(hasStage(BuiltInStages.MANY)).toBe(true)
    expect(hasStage(BuiltInStages.MAP)).toBe(true)
    expect(hasStage(BuiltInStages.SORT)).toBe(true)
    expect(hasStage(BuiltInStages.PROVIDER)).toBe(true)
    expect(hasStage(BuiltInStages.OBJECT)).toBe(true)
  })

  it('returns false for an unknown stage', function () {
    expect(hasStage(Symbol('unknown'))).toBe(false)
  })
})

describe('hasResolver()', function () {
  it('returns false for a name nothing registered', function () {
    expect(hasResolver(token<Record<string, unknown>>(Symbol('unknown')))).toBe(false)
  })
})

describe('bindResolver()', function () {
  it('registers a custom resolver', function () {
    const factory: InjectionResolverFactory = () => () => undefined
    bindResolver(kTestResolver, factory)
    expect(hasResolver(kTestResolver)).toBe(true)
  })

  it('throws ErrResolverAlreadyRegistered on duplicate name', function () {
    const factory: InjectionResolverFactory = () => () => undefined
    bindResolver(kTestResolver, factory)
    expect(() => bindResolver(kTestResolver, factory)).toThrow(ErrResolverAlreadyRegistered)
  })
})

describe('unbindResolver()', function () {
  it('removes a registered resolver', function () {
    bindResolver(kTestResolver, () => () => undefined)
    unbindResolver(kTestResolver)
    expect(hasResolver(kTestResolver)).toBe(false)
  })
})

describe('registerStage()', function () {
  const passthrough: InjectionMiddleware = (ctx, next) => next(ctx)

  it('registers a stage under a name', function () {
    registerStage(kTestStage, passthrough)
    expect(hasStage(kTestStage)).toBe(true)
  })

  it('throws ErrInjectionStageAlreadyRegistered on duplicate name', function () {
    registerStage(kTestStage, passthrough)
    expect(() => registerStage(kTestStage, passthrough)).toThrow(ErrInjectionStageAlreadyRegistered)
  })

  it('keeps stage names separate from resolver names', function () {
    registerStage(kTestStage, passthrough)
    bindResolver(kTestResolver, () => () => undefined)

    expect(hasResolver(kTestStage)).toBe(false)
    expect(hasStage(kTestResolver)).toBe(false)
  })
})

describe('a custom resolver composed with stages', function () {
  const kPlug = token<{ id: string }>(Symbol('custom-terminal-plug'))

  it('acts as the terminal, with a wrapping stage composed over it', async function () {
    bindResolver(kTestResolver, () => () => sentinel)

    class Holder {
      constructor(readonly dep: { get(): typeof sentinel }) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Holder, t =>
      t.toSelf([{ key: kPlug, resolver: kTestResolver, stages: [{ name: BuiltInStages.PROVIDER }] } as never]),
    )
    await di.init()

    expect(di.get(Holder).dep.get()).toBe(sentinel)
  })

  it('conflicts with a terminal stage naming both', async function () {
    bindResolver(kTestResolver, () => () => sentinel)

    class Holder {
      constructor(readonly dep: unknown) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Holder, t =>
      t.toSelf([{ key: kPlug, resolver: kTestResolver, stages: [{ name: BuiltInStages.MANY }] } as never]),
    )

    await expect(di.init()).rejects.toBeInstanceOf(ErrConflictingInjectionStages)
  })

  it('runs a custom transforming stage before the terminal', async function () {
    class Alpha {
      readonly id = 'alpha'
    }

    class Beta {
      readonly id = 'beta'
    }

    // The narrowing stage from the injection-resolvers reference: it changes the bindings and hands the rest of
    // the chain straight back.
    registerStage(kTestStage, (ctx, next) => next({ ...ctx, bindings: ctx.bindings.slice(0, 1) }))

    class Holder {
      constructor(readonly plugins: { id: string }[]) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Alpha, t => t.toSelf().names(kPlug))
    di.bind(Beta, t => t.toSelf().names(kPlug))
    di.bind(Holder, t =>
      t.toSelf([{ key: kPlug, stages: [{ name: kTestStage }, { name: BuiltInStages.MANY }] } as never]),
    )
    await di.init()

    expect(di.get(Holder).plugins).toHaveLength(1)
  })
})

describe('unregisterStage()', function () {
  it('removes a registered stage', function () {
    registerStage(kTestStage, (ctx, next) => next(ctx))
    unregisterStage(kTestStage)
    expect(hasStage(kTestStage)).toBe(false)
  })
})

describe('providerResolverFactory — missing binding (L-2)', function () {
  it('should throw ErrNoResolutionForKey at init() time when the injected key is not registered', async function () {
    const kMissing = token<Record<string, unknown>>(Symbol('missing-l2'))

    class Consumer {
      constructor(readonly dep: unknown) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Consumer, t => t.toSelf([$i.provide(kMissing)]))

    await expect(di.init()).rejects.toBeInstanceOf(ErrNoResolutionForKey)
  })

  it('should return a Provider whose get() is undefined when $i.provide() target is optional and missing', async function () {
    const kMissing = token<Record<string, unknown>>(Symbol('missing-optional-l2'))

    class OptConsumer {
      constructor(readonly dep: unknown) {}
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(OptConsumer, t => t.toSelf([$i.optional($i.provide(kMissing))]))
    await di.init()

    const inst = di.get(OptConsumer)
    expect(inst.dep).toBeDefined()
    expect((inst.dep as { get: () => unknown }).get()).toBeUndefined()
  })
})

describe('defaultResolverFactory', function () {
  it('should return undefined for optional missing dependencies', function () {
    const di = new CaffeineIoC({ decorators: false })
    const kMissing = token<Record<string, unknown>>(Symbol('resolver-missing-optional'))

    const resolver = compileChain({
      container: di,
      descriptor: $i.optional(kMissing),
      key: token<Record<string, unknown>>('consumer'),
      kind: 'constructor',
      member: 'miss',
      index: 0,
    })

    expect(resolver()).toBeUndefined()
  })

  it('should resolve all bindings for multiple injection', async function () {
    const kShared = token<Record<string, unknown>>(Symbol('resolver-shared-multi'))
    const di = new CaffeineIoC({ decorators: false })

    di.bind(token<string>('a'), t => t.toValue('one').names(kShared))
    di.bind(token<string>('b'), t => t.toValue('two').names(kShared))
    await di.init()

    const resolver = compileChain({
      container: di,
      descriptor: $i.allOf(kShared),
      key: token<Record<string, unknown>>('consumer'),
      kind: 'constructor',
      member: 'm',
      index: 0,
    })

    expect(resolver()).toEqual(['one', 'two'])
  })
})

describe('custom resolver end-to-end', function () {
  it('resolves using a registered factory', async function () {
    bindResolver(kTestResolver, () => () => sentinel)

    const di = new CaffeineIoC({ decorators: false })
    di.bind(CustomConsumer, t => t.toSelf([{ resolver: kTestResolver } as never]))
    await di.init()

    expect(di.get(CustomConsumer)!.dep).toBe(sentinel)
  })

  it('throws ErrUnknownResolver when resolver name is not registered', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(UnknownResolverConsumer, t =>
      t.toSelf([{ resolver: token<Record<string, unknown>>(Symbol('no-such-resolver')) } as never]),
    )

    await expect(di.init()).rejects.toBeInstanceOf(ErrUnknownResolver)
  })
})
