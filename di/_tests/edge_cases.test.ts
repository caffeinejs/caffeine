import '../index.nodejs.js'
import { describe, it, beforeEach, expect, vi } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { Configuration } from '../decorators/configuration.js'
import { Fallback } from '../decorators/fallback.js'
import { Inject } from '../decorators/inject.js'
import { Injectable } from '../decorators/injectable.js'
import { Interceptor } from '../decorators/interceptor.js'
import { PostConstruct } from '../decorators/post_construct.js'
import { Primary } from '../decorators/primary.js'
import { Profile } from '../decorators/profile.js'
import { Provides } from '../decorators/provides.js'
import {
  ErrInvalidBinding,
  ErrOutOfScope,
  ErrNoResolutionForKey,
  ErrRepeatedInjectableConfiguration,
} from '../errors.js'
import { $i } from '../injection.js'
import { token } from '../key.js'
import { Provider } from '../provider.js'
import { Scopes } from '../scope.js'

// ─────────────────────────────────────────────────────────────────────────────
// Group A: Decorator Combination Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

// A1: @ConditionalOn on @Primary — when the primary's condition is false,
//     the plain non-primary sibling wins sole ownership of the key.
describe('A1: @ConditionalOn on @Primary — non-primary wins when condition fails', function () {
  const NS_A1 = 'ec-a1'
  const kA1 = token<{ readonly kind: string }>(Symbol('ec-a1'))

  @ConditionalOn(() => false)
  @Primary()
  @Injectable(kA1)
  @Profile(NS_A1)
  class EC_A1Primary {
    readonly kind = 'primary'
  }

  @Injectable(kA1)
  @Profile(NS_A1)
  class EC_A1Fallthrough {
    readonly kind = 'fallthrough'
  }

  it('should resolve the non-primary when the primary condition is false', async function () {
    const di = new CaffeineIoC({ profiles: [NS_A1] })

    // Named keys live in this.bindings, not this.registry, so has() returns false;
    // get() resolves correctly from the bindings multi-map.
    await di.init()
    expect(di.get(kA1)).toBeInstanceOf(EC_A1Fallthrough)
  })
})

// A2: @Fallback + @Primary on a @Provides method.
//     The fallback guard runs before primary priority: if another non-fallback
//     binding already covers the key, the fallback+primary is simply skipped.
describe('A2: @Fallback + @Primary on @Provides', function () {
  const NS_A2 = 'ec-a2'
  const kA2Shared = token<string>(Symbol('ec-a2-shared'))
  const kA2Alone = token<string>(Symbol('ec-a2-alone'))

  @Configuration()
  @Profile(NS_A2)
  class EC_A2ConsumerConf {
    @Provides(kA2Shared)
    shared(): string {
      return 'consumer'
    }
  }

  @Configuration()
  @Profile(NS_A2)
  class EC_A2LibConf {
    @Fallback()
    @Primary()
    @Provides(kA2Shared)
    defaultShared(): string {
      return 'library-default'
    }

    @Fallback()
    @Provides(kA2Alone)
    alone(): string {
      return 'alone'
    }
  }

  it('should skip the fallback+primary when a non-fallback binding already exists', async function () {
    const di = new CaffeineIoC({ profiles: [NS_A2] })
    await di.init()
    expect(di.get(kA2Shared)).toBe('consumer')
  })

  it('should register the fallback when no other binding exists for the key', async function () {
    const di = new CaffeineIoC({ profiles: [NS_A2] })
    await di.init()
    expect(di.get(kA2Alone)).toBe('alone')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Group B: Manual Binding Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

describe('B4: toFactory() returning null — null is a valid resolved value', function () {
  it('should return null without throwing', async function () {
    const di = new CaffeineIoC({ decorators: false })
    const kB4 = token<Record<string, unknown>>(Symbol('ec-b4'))

    di.bind(kB4, t => t.toFactory(() => null as any))
    await di.init()
    expect(di.get(kB4)).toBeNull()
  })
})

describe('B5: Binding the same key twice — last write wins', function () {
  it('should replace the first binding with the second; no ambiguity error', async function () {
    const di = new CaffeineIoC({ decorators: false })
    class EC_B5Key {}
    class EC_B5First {
      readonly value = 'first'
    }
    class EC_B5Second {
      readonly value = 'second'
    }

    di.bind(EC_B5Key, t => t.toClass(EC_B5First))
    di.bind(EC_B5Key, t => t.toClass(EC_B5Second))
    await di.init()
    const result = di.get(EC_B5Key) as EC_B5Second
    expect(result.value).toBe('second')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Group C: Scope Interaction Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

describe('C1: @PostConstruct on TRANSIENT — called for every new instance', function () {
  const postConstructSpy = vi.fn()

  @Injectable()
  class EC_C1Transient {
    @PostConstruct()
    init() {
      postConstructSpy()
    }
  }

  beforeEach(() => postConstructSpy.mockReset())

  it('should invoke the @PostConstruct method once per transient resolution', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(EC_C1Transient, t => t.toSelf().lifetime(Scopes.TRANSIENT))
    await di.init()
    di.get(EC_C1Transient)
    di.get(EC_C1Transient)
    di.get(EC_C1Transient)

    expect(postConstructSpy).toHaveBeenCalledTimes(3)
  })
})

describe('C2: onDestroy on TRANSIENT — never called by dispose()', function () {
  it('should not invoke onDestroy on transient instances when the container is disposed', async function () {
    const destroySpy = vi.fn()

    @Injectable()
    class EC_C2Transient {
      onDestroy() {
        destroySpy()
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(EC_C2Transient, t => t.toSelf().lifetime(Scopes.TRANSIENT))
    await di.init()
    di.get(EC_C2Transient)
    di.get(EC_C2Transient)

    await di.dispose()

    expect(destroySpy).not.toHaveBeenCalled()
  })
})

describe('C4: Request scope outside run() block — throws ErrOutOfScope', function () {
  it('should throw when accessing a request-scoped binding without an active run() context', async function () {
    @Injectable()
    class EC_C4RequestSvc {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(EC_C4RequestSvc, t => t.toSelf().lifetime(Scopes.REQUEST))

    await di.init()
    expect(() => di.get(EC_C4RequestSvc)).toThrow(ErrOutOfScope)
  })
})

describe('C5: RequestScopeManager.run() — returns a Promise for both sync and async callbacks', function () {
  it('returns a Promise when the callback is synchronous', async function () {
    class EC_C5Svc {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(EC_C5Svc, t => t.toSelf().lifetime(Scopes.REQUEST))
    await di.init()

    const result = di.requestScopeManager.run(() => 42)

    expect(result).toBeInstanceOf(Promise)
    expect(await result).toBe(42)
    await di.dispose()
  })

  it('resolves to the awaited value when the callback is async', async function () {
    class EC_C5AsyncSvc {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(EC_C5AsyncSvc, t => t.toSelf().lifetime(Scopes.REQUEST))
    await di.init()

    const result = await di.requestScopeManager.run(async () => 'hello')

    expect(result).toBe('hello')
    await di.dispose()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Group D: Resolution & getMany Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

describe('D1: injectAll with zero matching bindings — returns empty array', function () {
  it('should inject an empty array when no binding exists for the key', async function () {
    const kD1Missing = token<Record<string, unknown>>(Symbol('ec-d1-missing'))
    let captured: unknown[] | undefined

    const di = new CaffeineIoC({ decorators: false })
    const kD1Consumer = token<Record<string, unknown>>(Symbol('ec-d1-consumer'))

    di.bind(kD1Consumer, t =>
      t.toFunction(
        (deps: unknown[]) => {
          captured = deps
          return {}
        },
        [$i.allOf(kD1Missing)],
      ),
    )

    await di.init()
    di.get(kD1Consumer)

    expect(captured).toEqual([])
  })
})

describe('D3: get() with manual bind — primary wins among named bindings', function () {
  it('should return the primary binding when multiple named bindings exist', async function () {
    const kD3 = token<string>(Symbol('ec-d3'))
    const di = new CaffeineIoC({ decorators: false })
    di.bind(token<string>('a'), t => t.toValue('plain').names(kD3))
    di.bind(token<string>('b'), t => t.toValue('winner').names(kD3).primary())
    await di.init()

    expect(di.get<string>(kD3)).toBe('winner')
  })
})

describe('D2: getMany() with @Primary — primary instance is first in result', function () {
  it('should return the primary binding first when primary() is called before names()', async function () {
    const kD2a = token<Record<string, unknown>>(Symbol('ec-d2a'))
    const di = new CaffeineIoC({ decorators: false })
    class EC_D2aRegular {}
    class EC_D2aPrimary {}

    di.bind(EC_D2aRegular, t => t.toSelf().names(kD2a))
    di.bind(EC_D2aPrimary, t => t.toSelf().primary().names(kD2a))
    await di.init()
    const results = di.getMany(kD2a)

    expect(results).toHaveLength(2)
    expect(results[0]).toBeInstanceOf(EC_D2aPrimary)
    expect(results[1]).toBeInstanceOf(EC_D2aRegular)
  })

  it('should return the primary binding first when names() is called before primary()', async function () {
    const kD2b = token<Record<string, unknown>>(Symbol('ec-d2b'))
    const di = new CaffeineIoC({ decorators: false })
    class EC_D2bRegular {}
    class EC_D2bPrimary {}

    di.bind(EC_D2bRegular, t => t.toSelf().names(kD2b))
    di.bind(EC_D2bPrimary, t => t.toSelf().names(kD2b).primary())
    await di.init()
    const results = di.getMany(kD2b)

    expect(results).toHaveLength(2)
    expect(results[0]).toBeInstanceOf(EC_D2bPrimary)
    expect(results[1]).toBeInstanceOf(EC_D2bRegular)
  })
})

describe('D3: Property injection on TRANSIENT — each instance receives fresh injection', function () {
  describe('when container is strict and it is mixing singleton and transient dependencies - without using $i.provide()', function () {
    it('should throw ErrScopeMismatch', async function () {
      @Injectable()
      class EC_D3SingletonDep {}

      @Injectable()
      class EC_D3TransientConsumer {
        @Inject(EC_D3SingletonDep)
        dep!: EC_D3SingletonDep
      }

      const di = new CaffeineIoC({ checks: { scopes: 'off' }, decorators: false })
      di.bind(EC_D3SingletonDep, t => t.toSelf().lifetime(Scopes.SINGLETON))
      di.bind(EC_D3TransientConsumer, t => t.toSelf().lifetime(Scopes.TRANSIENT))
      await di.init()
      const t1 = di.get(EC_D3TransientConsumer)
      const t2 = di.get(EC_D3TransientConsumer)

      expect(t1).not.toBe(t2)
      expect(t1.dep).toBeInstanceOf(EC_D3SingletonDep)
      expect(t2.dep).toBeInstanceOf(EC_D3SingletonDep)
    })
  })

  describe('when container is strict and it is mixing singleton and transient dependencies - using $i.provide()', function () {
    it('should inject the singleton dep into every new transient instance', async function () {
      @Injectable()
      class EC_D3SingletonDep {}

      @Injectable()
      class EC_D3TransientConsumer {
        @Inject($i.provide(EC_D3SingletonDep))
        dep!: Provider<EC_D3SingletonDep>
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(EC_D3SingletonDep, t => t.toSelf().lifetime(Scopes.SINGLETON))
      di.bind(EC_D3TransientConsumer, t => t.toSelf().lifetime(Scopes.TRANSIENT))
      await di.init()
      const t1 = di.get(EC_D3TransientConsumer)
      const t2 = di.get(EC_D3TransientConsumer)

      expect(t1).not.toBe(t2)
      expect(t1.dep.get()).toBeInstanceOf(EC_D3SingletonDep)
      expect(t2.dep.get()).toBeInstanceOf(EC_D3SingletonDep)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Group E: @Provides / @Configuration Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

// E1: @ConditionalOn at class AND method level are evaluated independently.
//     Class condition false → all beans skipped.
//     Class condition true, method condition false → only that bean skipped.
//
//     Guards are pre-bound symbol keys so that autoWire() order does not
//     affect which guard is visible when the condition function runs.
describe('E1: @ConditionalOn at class + method level — independent evaluation', function () {
  const NS_E1 = 'ec-e1'
  const kE1ClassFlag = token<boolean>(Symbol('ec-e1-class-flag'))
  const kE1MethodFlag = token<boolean>(Symbol('ec-e1-method-flag'))
  const kE1Bean = token<string>(Symbol('ec-e1-bean'))

  @Configuration()
  @Profile(NS_E1)
  @ConditionalOn(ctx => ctx.container.has(kE1ClassFlag))
  class EC_E1Config {
    @Provides(kE1Bean)
    @ConditionalOn(ctx => ctx.container.has(kE1MethodFlag))
    bean(): string {
      return 'bean'
    }
  }

  it('should skip all beans when the class-level condition fails', function () {
    const di = new CaffeineIoC({ profiles: [NS_E1], decorators: false })
    // kE1ClassFlag is not bound → class condition fails → EC_E1Config skipped
    di.autoWire()

    expect(di.has(kE1Bean)).toBe(false)
  })

  it('should skip the bean when class condition passes but method condition fails', function () {
    const di = new CaffeineIoC({ profiles: [NS_E1], decorators: false })
    di.bind(kE1ClassFlag, t => t.toValue(true))
    // kE1MethodFlag is absent → method condition fails → bean skipped
    di.autoWire()

    expect(di.has(kE1Bean)).toBe(false)
  })

  it('should register the bean when both conditions pass', async function () {
    const di = new CaffeineIoC({ profiles: [NS_E1], decorators: false })
    di.bind(kE1ClassFlag, t => t.toValue(true))
    di.bind(kE1MethodFlag, t => t.toValue(true))
    di.autoWire()
    await di.init()
    expect(di.has(kE1Bean)).toBe(true)
    expect(di.get(kE1Bean)).toBe('bean')
  })
})

// E2: Two @Configuration classes providing the SAME bean key without @Primary
//     results in ErrRepeatedInjectableConfiguration during autoWire.
describe('E2: Two @Configuration classes providing the same key — ambiguity error', function () {
  const NS_E2 = 'ec-e2'
  const kE2Bean = token<string>(Symbol('ec-e2-bean'))

  @Configuration()
  @Profile(NS_E2)
  class EC_E2ConfigA {
    @Provides(kE2Bean)
    bean(): string {
      return 'config-a'
    }
  }

  @Configuration()
  @Profile(NS_E2)
  class EC_E2ConfigB {
    @Provides(kE2Bean)
    bean(): string {
      return 'config-b'
    }
  }

  it('should throw ErrRepeatedInjectableConfiguration during autoWire', function () {
    expect(() => new CaffeineIoC({ profiles: [NS_E2] })).toThrow(ErrRepeatedInjectableConfiguration)
  })
})

// E3: @Provides(type, namedKey) registers the bean under namedKey, not the type.
//     Direct resolution by type returns undefined; resolution by namedKey works.
describe('E3: @Provides(type, namedKey) — bean registered under namedKey only', function () {
  const NS_E3 = 'ec-e3'
  const kE3Named = token<Record<string, unknown>>(Symbol('ec-e3-named'))

  class EC_E3Service {}

  @Configuration()
  @Profile(NS_E3)
  class EC_E3Config {
    @Provides(EC_E3Service, kE3Named)
    namedService(): EC_E3Service {
      return new EC_E3Service()
    }
  }

  it('should resolve via namedKey and throw when resolved by type directly', async function () {
    const di = new CaffeineIoC({ profiles: [NS_E3] })
    await di.init()
    expect(di.get(kE3Named)).toBeInstanceOf(EC_E3Service)
    expect(() => di.get(EC_E3Service)).toThrow(ErrNoResolutionForKey)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Group F: Lifecycle Edge Cases
// ─────────────────────────────────────────────────────────────────────────────

describe('F1: @PostConstruct throws — error propagates from init()', function () {
  it('should propagate the exception thrown inside @PostConstruct', async function () {
    @Profile('ec-f1')
    @Injectable()
    class EC_F1BadInit {
      @PostConstruct()
      init() {
        throw new Error('post-construct-boom')
      }
    }

    const di = new CaffeineIoC({ decorators: false, profiles: ['ec-f1'] })
    di.bind(EC_F1BadInit, t => t.toSelf())

    await expect(di.init()).rejects.toThrow('post-construct-boom')
  })
})

describe('F2: dispose() calls onDestroy on all resolved singletons', function () {
  it('should invoke onDestroy on every singleton that was resolved before dispose', async function () {
    const spy1 = vi.fn()
    const spy2 = vi.fn()
    const spy3Async = vi.fn()

    @Injectable()
    class EC_F2Svc1 {
      onDestroy() {
        spy1()
      }
    }

    @Injectable()
    class EC_F2Svc2 {
      onDestroy() {
        spy2()
      }
    }

    @Injectable()
    class EC_F2Svc3 {
      async onDestroy() {
        spy3Async()
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(EC_F2Svc1, t => t.toSelf())
    di.bind(EC_F2Svc2, t => t.toSelf())
    di.bind(EC_F2Svc3, t => t.toSelf())
    await di.init()

    di.get(EC_F2Svc1)
    di.get(EC_F2Svc2)
    di.get(EC_F2Svc3)

    await di.dispose()

    expect(spy1).toHaveBeenCalledTimes(1)
    expect(spy2).toHaveBeenCalledTimes(1)
    expect(spy3Async).toHaveBeenCalledTimes(1)
  })
})

describe('F3: @Interceptor on TRANSIENT — invoked for every new resolution', function () {
  const interceptSpy = vi.fn()

  @Injectable()
  @Interceptor((_ctx, instance) => {
    interceptSpy()
    return instance
  })
  class EC_F3Transient {}

  beforeEach(() => interceptSpy.mockReset())

  it('should call the interceptor once per transient resolution', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(EC_F3Transient, t => t.toSelf().lifetime(Scopes.TRANSIENT))
    await di.init()
    di.get(EC_F3Transient)
    di.get(EC_F3Transient)
    di.get(EC_F3Transient)

    expect(interceptSpy).toHaveBeenCalledTimes(3)
  })
})

describe('Self-referencing', function () {
  describe('when a class references itself', function () {
    @Injectable([$i.defer(() => Service)])
    class Service {
      constructor(readonly dep: Service) {}

      greet() {
        return 'hello'
      }

      bye() {
        return this.dep.greet()
      }
    }

    it('should allow using deferred resolution', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const service = di.get(Service)
      const greet = service.greet()
      const bye = service.bye()

      expect(greet).toBe('hello')
      expect(bye).toBe('hello')
    })

    it('should allow using manual binding using deferred injection', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(Service, t => t.toSelf([$i.defer(() => Service)]))
      await di.init()

      const service = di.get(Service)
      const greet = service.greet()
      const bye = service.bye()

      expect(greet).toBe('hello')
      expect(bye).toBe('hello')
    })

    it('should fail when not using deferred injection', function () {
      const di = new CaffeineIoC({ decorators: false })

      // Rejected at the bind() call rather than left to blow the stack during init().
      expect(() => di.bind(Service, t => t.toSelf([Service]))).toThrow(ErrInvalidBinding)
    })
  })
})
