import { describe, it, afterEach, beforeEach, expect, vi } from 'vitest'

import { $cond } from '../conditional.js'
import { CaffeineIoC } from '../container.js'
import { ContainerBindingOps } from '../container_interface.js'
import { Conditional } from '../decorators/conditional.js'
import { Configuration } from '../decorators/configuration.js'
import { Extends } from '../decorators/extends.js'
import { Injectable } from '../decorators/injectable.js'
import { Profile } from '../decorators/profile.js'
import { Provides } from '../decorators/provides.js'
import { DeferredCtor } from '../deferred_ctor.js'
import {
  ErrCircularCondition,
  ErrDuplicateBinding,
  ErrInvalidBinding,
  ErrInvalidContainerState,
  ErrInvalidDecorator,
  ErrNoValuesProvider,
} from '../errors.js'
import { $i } from '../injection.js'
import { token } from '../key.js'
import { mod } from '../module.js'
import { always, kUnbound, never } from './_conditional.js'

describe('Conditionals', function () {
  describe('using default conditional', function () {
    class NonManaged {}

    @Injectable()
    class Managed {}

    @Injectable()
    @Conditional(c => c.present(NonManaged))
    class NoPass {}

    @Injectable()
    @Conditional(c => c.present(NonManaged))
    @Conditional(c => c.env('NODE', 'test'))
    class NoPassToo {}

    @Injectable()
    @Conditional(c => c.present(Managed))
    @Conditional(always)
    class Pass {}

    @Injectable([Pass])
    class RefPassed {
      constructor(readonly pass: Pass) {}
    }

    @Injectable([$i.optional(NoPass)])
    class RefNotPassed {
      constructor(readonly noPass: NoPass | undefined) {}
    }
    void RefNotPassed

    @Injectable([$i.optional(NoPass)])
    class RefNotPassedOptional {
      constructor(readonly noPass?: NoPass) {}
    }

    it('should only register components that pass all provided conditions', async function () {
      const di = new CaffeineIoC()

      expect(di.has(Pass)).toBeFalsy()
      expect(di.has(NoPass)).toBeFalsy()
      expect(di.has(NoPassToo)).toBeFalsy()

      await di.init()

      expect(di.has(Pass)).toBeTruthy()
      expect(di.has(NoPass)).toBeFalsy()
      expect(di.has(NoPassToo)).toBeFalsy()
    })

    it('should resolve components that pass conditions and handle optional absent deps', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(Managed, t => t.toSelf())
      di.bind(Pass, t => t.toSelf())
      di.bind(RefPassed, t => t.toSelf([Pass]))
      di.bind(RefNotPassedOptional, t => t.toSelf([$i.optional(NoPass)]))
      await di.init()

      const refPassed = di.get(RefPassed)
      const opt = di.get(RefNotPassedOptional)

      expect(refPassed).toBeInstanceOf(RefPassed)
      expect(refPassed.pass).toBeInstanceOf(Pass)
      expect(opt).toBeInstanceOf(RefNotPassedOptional)
      expect(opt.noPass).toBeUndefined()
    })
  })

  describe('conditional evaluated during container initialization - sees module and manual bindings', function () {
    it('should register a component whose conditional checks a module-registered binding', async function () {
      class ModuleSvc {}

      @Injectable()
      @Conditional(c => c.present(ModuleSvc))
      class DependsOnModuleSvc {}

      const di = new CaffeineIoC({
        modules: [
          (container: ContainerBindingOps) => {
            container.bind(ModuleSvc, t => t.toSelf())
          },
        ],
      })

      await di.init()

      expect(di.has(DependsOnModuleSvc)).toBeTruthy()
    })

    it('should not register a component when the checked binding is absent', async function () {
      class NeverBound {}

      @Injectable()
      @Conditional(c => c.present(NeverBound))
      class DependsOnNeverBound {}

      const di = new CaffeineIoC()
      await di.init()

      expect(di.has(DependsOnNeverBound)).toBeFalsy()
    })
  })

  describe('env', function () {
    const kEnv = token<string>(Symbol('cond-env'))

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('should pass when the variable is set, an empty value included', async function () {
      vi.stubEnv('CAFFEINE_COND_ENV_SET', '')

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kEnv, t => t.toValue('set').conditional(c => c.env('CAFFEINE_COND_ENV_SET')))
      await di.init()

      expect(di.get(kEnv)).toBe('set')
    })

    it('should fail when the variable is not set', async function () {
      vi.stubEnv('CAFFEINE_COND_ENV_UNSET', undefined)

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kEnv, t => t.toValue('set').conditional(c => c.env('CAFFEINE_COND_ENV_UNSET')))
      await di.init()

      expect(di.has(kEnv)).toBe(false)
    })

    it('should compare the value when one is expected', async function () {
      vi.stubEnv('CAFFEINE_COND_ENV_REGION', 'eu')
      const kEU = token<string>(Symbol('cond-env-eu'))
      const kUS = token<string>(Symbol('cond-env-us'))

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kEU, t => t.toValue('eu').conditional(c => c.env('CAFFEINE_COND_ENV_REGION', 'eu')))
      di.bind(kUS, t => t.toValue('us').conditional(c => c.env('CAFFEINE_COND_ENV_REGION', 'us')))
      await di.init()

      expect(di.has(kEU)).toBe(true)
      expect(di.has(kUS)).toBe(false)
    })

    it('should read the variable when the container compiles, not when the condition is written', async function () {
      vi.stubEnv('CAFFEINE_COND_ENV_LATE', undefined)
      const condition = $cond.env('CAFFEINE_COND_ENV_LATE')

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kEnv, t => t.toValue('set').conditional(condition))
      vi.stubEnv('CAFFEINE_COND_ENV_LATE', 'on')
      await di.init()

      expect(di.get(kEnv)).toBe('set')
    })
  })

  describe('config', function () {
    type AppConfig = { cache: { enabled: boolean } }

    const kCache = token<string>(Symbol('cond-config-cache'))
    const enabled = $cond.config<AppConfig>(cfg => cfg.cache.enabled)

    it('should pass when the test returns true for the bound values', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bindConfig<AppConfig>({ cache: { enabled: true } })
      di.bind(kCache, t => t.toValue('cache').conditional(enabled))
      await di.init()

      expect(di.get(kCache)).toBe('cache')
    })

    it('should fail when the test returns false', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bindConfig<AppConfig>({ cache: { enabled: false } })
      di.bind(kCache, t => t.toValue('cache').conditional(enabled))
      await di.init()

      expect(di.has(kCache)).toBe(false)
    })

    it('should fail the compilation when no values are bound', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kCache, t => t.toValue('cache').conditional(enabled))

      await expect(di.init()).rejects.toThrow(ErrNoValuesProvider)
    })

    it('should refuse a test that does not return a boolean, such as an async one', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bindConfig({})
      di.bind(kCache, t => t.toValue('cache').conditional(c => c.config((async () => true) as never)))

      await expect(di.init()).rejects.toThrow(ErrInvalidBinding)
    })

    it('should report a test that throws, with the error as its cause', async function () {
      const failure = new TypeError('no cache section')

      const di = new CaffeineIoC({ decorators: false })
      di.bindConfig({})
      di.bind(kCache, t =>
        t.toValue('cache').conditional(
          $cond.config(() => {
            throw failure
          }),
        ),
      )

      await expect(di.init()).rejects.toThrow(expect.objectContaining({ name: 'ErrInvalidBinding', cause: failure }))
    })
  })

  describe('input', function () {
    const kOne = token<string>(Symbol('cond-input-one'))
    const kList = token<string>(Symbol('cond-input-list'))
    const kCallback = token<string>(Symbol('cond-input-callback'))
    const kCallbackList = token<string>(Symbol('cond-input-callback-list'))
    const kChained = token<string>(Symbol('cond-input-chained'))

    @Injectable()
    @Profile('cond-input')
    @Conditional([always, $cond.missing(kOne)])
    @Conditional(c => c.missing(kList))
    class DecoratedPass {}

    @Injectable()
    @Profile('cond-input')
    @Conditional(always)
    @Conditional(c => [always, c.present(kUnbound)])
    class DecoratedFail {}

    it('should take one condition, a list, or a callback returning either', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kOne, t => t.toValue('one').conditional(always))
      di.bind(kList, t => t.toValue('list').conditional([always, never]))
      di.bind(kCallback, t => t.toValue('callback').conditional(c => c.missing(kUnbound)))
      di.bind(kCallbackList, t => t.toValue('callback list').conditional(c => [always, c.missing(kUnbound)]))
      await di.init()

      expect(di.has(kOne)).toBe(true)
      expect(di.has(kList)).toBe(false)
      expect(di.has(kCallback)).toBe(true)
      expect(di.has(kCallbackList)).toBe(true)
    })

    it('should need every condition of every .conditional() call', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kChained, t => t.toValue('chained').conditional(always).conditional(never))
      await di.init()

      expect(di.has(kChained)).toBe(false)
    })

    it('should need every condition of every @Conditional', async function () {
      const di = new CaffeineIoC({ profiles: ['cond-input'] })
      await di.init()

      expect(di.has(DecoratedPass)).toBe(true)
      expect(di.has(DecoratedFail)).toBe(false)
    })
  })

  describe('invalid conditions', function () {
    class Svc {}

    it('should refuse a value that is not a condition', function () {
      expect(() => Conditional('x' as never)).toThrow(ErrInvalidDecorator)
      expect(() => Conditional([{ kind: 'present' }] as never)).toThrow(ErrInvalidDecorator)
      expect(() => new CaffeineIoC().bind(Svc, t => t.toSelf().conditional(true as never))).toThrow(ErrInvalidBinding)
    })

    it('should refuse a callback that returns a boolean', function () {
      expect(() => Conditional((() => true) as never)).toThrow(ErrInvalidDecorator)
    })

    it('should point an old predicate to the helpers, with its error as the cause', function () {
      const predicate = (ctx: { container: { has(key: unknown): boolean } }) => ctx.container.has(Svc)

      expect(() => Conditional(predicate as never)).toThrow(
        expect.objectContaining({
          name: 'ErrInvalidDecorator',
          message: expect.stringContaining('c => c.present(X)'),
          cause: expect.any(TypeError),
        }),
      )
    })

    it('should check the arguments of the helpers', function () {
      expect(() => $cond.present(undefined as never)).toThrow(ErrInvalidBinding)
      expect(() => $cond.missing(new DeferredCtor(() => Svc))).toThrow(ErrInvalidBinding)
      expect(() => $cond.env('')).toThrow(ErrInvalidBinding)
      expect(() => $cond.env('REGION', 1 as never)).toThrow(ErrInvalidBinding)
      expect(() => $cond.config('cache.enabled' as never)).toThrow(ErrInvalidBinding)
    })
  })

  describe('BindingSpec.conditional()', function () {
    it('should keep a manually-bound component when its conditional passes', async function () {
      class PresenceSvc {}
      class ConditionalSvc {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(PresenceSvc, t => t.toSelf())
      di.bind(ConditionalSvc, t => t.toSelf().conditional(c => c.present(PresenceSvc)))
      await di.init()

      expect(di.has(ConditionalSvc)).toBeTruthy()
      expect(di.get(ConditionalSvc)).toBeInstanceOf(ConditionalSvc)
    })

    it('should remove a manually-bound component when its conditional fails', async function () {
      class AbsentSvc {}
      class ConditionalSvcFailing {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(ConditionalSvcFailing, t => t.toSelf().conditional(c => c.present(AbsentSvc)))
      await di.init()

      expect(di.has(ConditionalSvcFailing)).toBeFalsy()
    })

    it('should leave another binding answering to the key of a removed component', async function () {
      // Removing the binding registered under a key takes out that binding alone: one named after the key still
      // answers to it. The whole list under the key used to go with it.
      interface Channel {
        kind(): string
      }

      const kChannel = token<Channel>(Symbol('conditional-channel'))

      class FailingChannel implements Channel {
        kind(): string {
          return 'failing'
        }
      }

      class NamedChannel implements Channel {
        kind(): string {
          return 'named'
        }
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kChannel, t => t.toClass(FailingChannel).conditional(never))
      di.bind(NamedChannel, t => t.toSelf().names(kChannel))
      await di.init()

      expect(di.get(kChannel).kind()).toBe('named')
    })

    // A binding made by hand waits for compile() like a decorated one. Registered at bind time, its condition saw the
    // binding itself, and it replaced a binding of its key before the condition ran — so a default written as
    // `.conditional(c => c.missing(key))` removed itself, or took the application's own binding with it.
    describe('held back until compile()', function () {
      abstract class Hasher {
        abstract kind(): string
      }

      class ScryptHasher extends Hasher {
        kind(): string {
          return 'scrypt'
        }
      }

      class ArgonHasher extends Hasher {
        kind(): string {
          return 'argon'
        }
      }

      @Injectable()
      @Extends()
      @Profile('conditional-held-back-decorated')
      class DecoratedHasher extends Hasher {
        kind(): string {
          return 'decorated'
        }
      }

      const bindDefault = (di: CaffeineIoC) =>
        di.bind(Hasher, t => t.toClass(ScryptHasher).conditional(c => c.missing(Hasher)))

      it('should register a default when nothing else answers to its key', async function () {
        const di = new CaffeineIoC({ decorators: false })
        bindDefault(di)
        await di.init()

        expect(di.get(Hasher).kind()).toBe('scrypt')
      })

      it('should let a default yield to a binding of its key made before it', async function () {
        const di = new CaffeineIoC({ decorators: false })
        di.bind(Hasher, t => t.toClass(ArgonHasher))
        bindDefault(di)
        await di.init()

        expect(di.get(Hasher).kind()).toBe('argon')
      })

      it('should let a default yield to a binding of its key made after it', async function () {
        const di = new CaffeineIoC({ decorators: false })
        bindDefault(di)
        di.bind(Hasher, t => t.toClass(ArgonHasher))
        await di.init()

        expect(di.get(Hasher).kind()).toBe('argon')
      })

      it('should let a default yield to an implementation a module registers', async function () {
        const di = new CaffeineIoC({
          decorators: false,
          modules: [mod('argon-hasher', container => container.bind(ArgonHasher, t => t.toSelf().extends(Hasher)))],
        })
        bindDefault(di)
        await di.init()

        expect(di.getMany(Hasher).map(h => h.kind())).toEqual(['argon'])
      })

      it('should let a default yield to a decorated implementation', async function () {
        const di = new CaffeineIoC({ profiles: ['conditional-held-back-decorated'] })
        bindDefault(di)
        await di.init()

        expect(di.get(Hasher)).toBeInstanceOf(DecoratedHasher)
      })

      it('should not be visible before init()', async function () {
        const di = new CaffeineIoC({ decorators: false })
        di.bind(ScryptHasher, t => t.toSelf().conditional(always))

        expect(di.has(ScryptHasher)).toBe(false)

        await di.init()

        expect(di.has(ScryptHasher)).toBe(true)
      })

      it('should conflict with another binding of its key when its condition passes', async function () {
        const di = new CaffeineIoC({ decorators: false })
        di.bind(Hasher, t => t.toClass(ScryptHasher).conditional(always))
        di.bind(Hasher, t => t.toClass(ArgonHasher))

        await expect(di.init()).rejects.toThrow(ErrDuplicateBinding)
      })

      it('should be discarded by a rebind() of its key', async function () {
        const di = new CaffeineIoC({ decorators: false })
        di.bind(Hasher, t => t.toClass(ScryptHasher).conditional(always))
        di.rebind(Hasher, t => t.toClass(ArgonHasher))
        await di.init()

        expect(di.get(Hasher).kind()).toBe('argon')
      })

      it('should leave the earlier binding of its key in place when its condition fails', async function () {
        const di = new CaffeineIoC({ decorators: false })
        di.bind(Hasher, t => t.toClass(ArgonHasher))
        di.bind(Hasher, t => t.toClass(ScryptHasher).conditional(never))
        await di.init()

        expect(di.get(Hasher).kind()).toBe('argon')
      })

      it('should still be matched against the active profiles', async function () {
        const di = new CaffeineIoC({ decorators: false, profiles: ['prod'] })
        di.bind(ScryptHasher, t => t.toSelf().profiles('test').conditional(always))
        await di.init()

        expect(di.has(ScryptHasher)).toBe(false)
      })

      it('should keep a default that won through snapshot() and restore()', async function () {
        // What TestContainer does with an initialized application container.
        const source = new CaffeineIoC({ decorators: false })
        bindDefault(source)
        await source.init()

        const di = new CaffeineIoC({ decorators: false })
        di.restore(source.snapshot())
        await di.init()

        expect(di.get(Hasher).kind()).toBe('scrypt')
      })

      it('should carry a binding still waiting on its conditions through snapshot() and restore()', async function () {
        const source = new CaffeineIoC({ decorators: false })
        bindDefault(source)

        const di = new CaffeineIoC({ decorators: false })
        di.restore(source.snapshot())
        await di.init()

        expect(di.get(Hasher).kind()).toBe('scrypt')
      })
    })
  })

  describe('conditional @Configuration cascade', function () {
    it('should skip all provides of a configuration class that fails its conditional', async function () {
      const kCascadedProvide = token<string>(Symbol('cascadedProvide'))

      @Configuration()
      @Conditional(never)
      class FailingConf {
        @Provides(kCascadedProvide)
        provided() {
          return 'value'
        }
      }
      void FailingConf

      const di = new CaffeineIoC()
      await di.init()

      expect(di.has(FailingConf)).toBeFalsy()
      expect(di.has(kCascadedProvide)).toBeFalsy()
    })

    it('should register all provides of a configuration class that passes its conditional', async function () {
      const kPassingProvide = token<string>(Symbol('passingProvide'))

      @Configuration()
      @Conditional(always)
      class PassingConf {
        @Provides(kPassingProvide)
        provided() {
          return 'value'
        }
      }
      void PassingConf

      const di = new CaffeineIoC()
      await di.init()

      expect(di.has(PassingConf)).toBeTruthy()
      expect(di.has(kPassingProvide)).toBeTruthy()
      expect(di.get(kPassingProvide)).toEqual('value')
    })
  })

  // A configuration class's conditions decide its own @Provides alone. A failing one used to take the @Provides of
  // another class with it when both provided the same key (#47).
  describe('a @Provides of a key another, failing configuration class also provides', function () {
    const kValue = token<string>(Symbol('cond-47-value'))

    @Configuration()
    @Profile('cond-47-failing-first')
    @Conditional(never)
    class FailingFirst {
      @Provides(kValue)
      value(): string {
        return 'failing'
      }
    }

    @Configuration()
    @Profile('cond-47-failing-first')
    class RegularSecond {
      @Provides(kValue)
      value(): string {
        return 'regular'
      }
    }

    @Configuration()
    @Profile('cond-47-regular-first')
    class RegularFirst {
      @Provides(kValue)
      value(): string {
        return 'regular'
      }
    }

    @Configuration()
    @Profile('cond-47-regular-first')
    @Conditional(never)
    class FailingSecond {
      @Provides(kValue)
      value(): string {
        return 'failing'
      }
    }

    it('should register when the failing class is declared first', async function () {
      const di = new CaffeineIoC({ profiles: ['cond-47-failing-first'] })
      await di.init()

      expect(di.has(FailingFirst)).toBe(false)
      expect(di.has(RegularSecond)).toBe(true)
      expect(di.get(kValue)).toBe('regular')
    })

    it('should register when the failing class is declared last', async function () {
      const di = new CaffeineIoC({ profiles: ['cond-47-regular-first'] })
      await di.init()

      expect(di.has(FailingSecond)).toBe(false)
      expect(di.has(RegularFirst)).toBe(true)
      expect(di.get(kValue)).toBe('regular')
    })
  })

  // A key bound by hand that a configuration class also provides is a clash, whether the class carries conditions or
  // not. A conditional class's @Provides used to replace the binding made by hand, silently (#48).
  describe('a key bound by hand that a configuration class also provides', function () {
    const kConditional = token<string>(Symbol('cond-48-conditional'))
    const kPlain = token<string>(Symbol('cond-48-plain'))

    @Configuration()
    @Profile('cond-48-conditional')
    @Conditional(always)
    class ConditionalProvider {
      @Provides(kConditional)
      value(): string {
        return 'provided'
      }
    }
    void ConditionalProvider

    @Configuration()
    @Profile('cond-48-plain')
    class PlainProvider {
      @Provides(kPlain)
      value(): string {
        return 'provided'
      }
    }
    void PlainProvider

    it('should fail when the class carries conditions', async function () {
      const di = new CaffeineIoC({ profiles: ['cond-48-conditional'] })
      di.bind(kConditional, t => t.toValue('hand'))

      await expect(di.init()).rejects.toThrow(ErrDuplicateBinding)
    })

    it('should fail the same way when the class carries none', async function () {
      const di = new CaffeineIoC({ profiles: ['cond-48-plain'] })
      di.bind(kPlain, t => t.toValue('hand'))

      await expect(di.init()).rejects.toThrow(ErrDuplicateBinding)
    })
  })

  // A present() or missing() condition is decided after every binding that could answer to its key, so what registers
  // does not depend on the order bindings were declared or bound in. A default decided before a conditional competitor
  // used to register beside it (#49).
  describe('decision order', function () {
    abstract class Store {
      abstract kind(): string
    }

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    describe('a decorated default and a conditional competitor', function () {
      @Injectable()
      @Extends()
      @Profile('cond-order-default-first')
      @Conditional(c => c.missing(Store))
      class MemoryFirst extends Store {
        kind() {
          return 'memory'
        }
      }

      @Injectable()
      @Extends()
      @Profile('cond-order-default-first')
      @Conditional(c => c.env('CAFFEINE_COND_REDIS'))
      class RedisSecond extends Store {
        kind() {
          return 'redis'
        }
      }

      @Injectable()
      @Extends()
      @Profile('cond-order-default-last')
      @Conditional(c => c.env('CAFFEINE_COND_REDIS'))
      class RedisFirst extends Store {
        kind() {
          return 'redis'
        }
      }

      @Injectable()
      @Extends()
      @Profile('cond-order-default-last')
      @Conditional(c => c.missing(Store))
      class MemorySecond extends Store {
        kind() {
          return 'memory'
        }
      }
      void [MemoryFirst, RedisSecond, RedisFirst, MemorySecond]

      it('should yield to the competitor declared after it', async function () {
        vi.stubEnv('CAFFEINE_COND_REDIS', 'on')

        const di = new CaffeineIoC({ profiles: ['cond-order-default-first'] })
        await di.init()

        expect(di.getMany(Store).map(store => store.kind())).toEqual(['redis'])
      })

      it('should yield to the competitor declared before it', async function () {
        vi.stubEnv('CAFFEINE_COND_REDIS', 'on')

        const di = new CaffeineIoC({ profiles: ['cond-order-default-last'] })
        await di.init()

        expect(di.getMany(Store).map(store => store.kind())).toEqual(['redis'])
      })

      it('should register when the competitor does not, whatever the order', async function () {
        vi.stubEnv('CAFFEINE_COND_REDIS', undefined)

        for (const profile of ['cond-order-default-first', 'cond-order-default-last']) {
          const di = new CaffeineIoC({ profiles: [profile] })
          await di.init()

          expect(di.getMany(Store).map(store => store.kind())).toEqual(['memory'])
        }
      })
    })

    describe('a default and a conditional competitor bound by hand', function () {
      class MemoryStore extends Store {
        kind() {
          return 'memory'
        }
      }

      class RedisStore extends Store {
        kind() {
          return 'redis'
        }
      }

      const bindDefault = (di: CaffeineIoC) =>
        di.bind(MemoryStore, t =>
          t
            .toSelf()
            .extends(Store)
            .conditional(c => c.missing(Store)),
        )
      const bindCompetitor = (di: CaffeineIoC) =>
        di.bind(RedisStore, t => t.toSelf().extends(Store).conditional(always))

      it('should yield to the competitor bound after it', async function () {
        const di = new CaffeineIoC({ decorators: false })
        bindDefault(di)
        bindCompetitor(di)
        await di.init()

        expect(di.getMany(Store).map(store => store.kind())).toEqual(['redis'])
      })

      it('should yield to the competitor bound before it', async function () {
        const di = new CaffeineIoC({ decorators: false })
        bindCompetitor(di)
        bindDefault(di)
        await di.init()

        expect(di.getMany(Store).map(store => store.kind())).toEqual(['redis'])
      })
    })

    it('should let present() see what a missing() default registers', async function () {
      class ScryptStore extends Store {
        kind() {
          return 'scrypt'
        }
      }

      class StoreMetrics {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(StoreMetrics, t => t.toSelf().conditional(c => c.present(Store)))
      di.bind(Store, t => t.toClass(ScryptStore).conditional(c => c.missing(Store)))
      await di.init()

      expect(di.has(StoreMetrics)).toBe(true)
    })

    it('should decide a chain of present() conditions declared in reverse', async function () {
      const kA = token<string>(Symbol('cond-chain-a'))
      const kB = token<string>(Symbol('cond-chain-b'))
      const kC = token<string>(Symbol('cond-chain-c'))

      const bindChain = (last: typeof always) => {
        const di = new CaffeineIoC({ decorators: false })
        di.bind(kA, t => t.toValue('a').conditional(c => c.present(kB)))
        di.bind(kB, t => t.toValue('b').conditional(c => c.present(kC)))
        di.bind(kC, t => t.toValue('c').conditional(last))
        return di
      }

      const all = bindChain(always)
      await all.init()
      expect([all.has(kA), all.has(kB), all.has(kC)]).toEqual([true, true, true])

      const none = bindChain(never)
      await none.init()
      expect([none.has(kA), none.has(kB), none.has(kC)]).toEqual([false, false, false])
    })

    describe('a configuration class that provides the key it checks is missing', function () {
      const kDataSource = token<string>(Symbol('cond-autoconf-ds'))

      @Configuration()
      @Profile('cond-autoconf')
      @Conditional(c => c.missing(kDataSource))
      class DataSourceDefaults {
        @Provides(kDataSource)
        dataSource(): string {
          return 'default'
        }
      }

      it('should register with its @Provides when nothing else provides the key', async function () {
        const di = new CaffeineIoC({ profiles: ['cond-autoconf'] })
        await di.init()

        expect(di.has(DataSourceDefaults)).toBe(true)
        expect(di.get(kDataSource)).toBe('default')
      })

      it('should yield to an application binding of the key, conditional or not', async function () {
        for (const bind of [
          (di: CaffeineIoC) => di.bind(kDataSource, t => t.toValue('application')),
          (di: CaffeineIoC) => di.bind(kDataSource, t => t.toValue('application').conditional(always)),
        ]) {
          const di = new CaffeineIoC({ profiles: ['cond-autoconf'] })
          bind(di)
          await di.init()

          expect(di.has(DataSourceDefaults)).toBe(false)
          expect(di.get(kDataSource)).toBe('application')
        }
      })
    })

    describe('bindings that wait for each other', function () {
      class ConsoleStore extends Store {
        kind() {
          return 'console'
        }
      }

      class FileStore extends Store {
        kind() {
          return 'file'
        }
      }

      const bindDefaults = (di: CaffeineIoC) => {
        di.bind(ConsoleStore, t =>
          t
            .toSelf()
            .extends(Store)
            .conditional(c => c.missing(Store)),
        )
        di.bind(FileStore, t =>
          t
            .toSelf()
            .extends(Store)
            .conditional(c => c.missing(Store)),
        )
      }

      it('should refuse two defaults of a key nothing else binds, naming both', async function () {
        const di = new CaffeineIoC({ decorators: false })
        bindDefaults(di)

        const error = await di.init().catch((err: unknown) => err)

        expect(error).toBeInstanceOf(ErrCircularCondition)
        expect((error as Error).message).toContain('"ConsoleStore" checks "Store", which "FileStore" answers to')
        expect((error as Error).message).toContain('"FileStore" checks "Store", which "ConsoleStore" answers to')
      })

      it('should settle once the key is bound', async function () {
        const own: Store = { kind: () => 'own' }

        const di = new CaffeineIoC({ decorators: false })
        bindDefaults(di)
        di.bind(Store, t => t.toValue(own))
        await di.init()

        expect(di.getMany(Store)).toEqual([own])
      })

      it('should not wait for a binding whose env condition fails', async function () {
        vi.stubEnv('CAFFEINE_COND_CYCLE_OFF', undefined)

        const di = new CaffeineIoC({ decorators: false })
        di.bind(ConsoleStore, t =>
          t
            .toSelf()
            .extends(Store)
            .conditional(c => c.missing(Store)),
        )
        di.bind(FileStore, t =>
          t
            .toSelf()
            .extends(Store)
            .conditional(c => [c.missing(Store), c.env('CAFFEINE_COND_CYCLE_OFF')]),
        )
        await di.init()

        expect(di.getMany(Store).map(store => store.kind())).toEqual(['console'])
      })

      it('should refuse bindings that each check the other is missing', async function () {
        const kA = token<string>(Symbol('cond-cycle-a'))
        const kB = token<string>(Symbol('cond-cycle-b'))

        const di = new CaffeineIoC({ decorators: false })
        di.bind(kA, t => t.toValue('a').conditional(c => c.missing(kB)))
        di.bind(kB, t => t.toValue('b').conditional(c => c.missing(kA)))

        await expect(di.init()).rejects.toThrow(ErrCircularCondition)
      })

      describe('two configuration classes that each provide the key they check is missing', function () {
        const kCache = token<string>(Symbol('cond-cycle-cache'))

        @Configuration()
        @Profile('cond-cycle-autoconf')
        @Conditional(c => c.missing(kCache))
        class FirstDefaults {
          @Provides(kCache)
          cache(): string {
            return 'first'
          }
        }

        @Configuration()
        @Profile('cond-cycle-autoconf')
        @Conditional(c => c.missing(kCache))
        class SecondDefaults {
          @Provides(kCache)
          cache(): string {
            return 'second'
          }
        }
        void [FirstDefaults, SecondDefaults]

        it('should refuse them, naming the @Provides by class and method', async function () {
          const di = new CaffeineIoC({ profiles: ['cond-cycle-autoconf'] })

          const error = await di.init().catch((err: unknown) => err)

          expect(error).toBeInstanceOf(ErrCircularCondition)
          expect((error as Error).message).toContain('"SecondDefaults.cache()" waits for its configuration class')
        })
      })
    })

    it('should check env and config conditions before present() and missing() ones', async function () {
      const kMixed = token<string>(Symbol('cond-mixed'))
      const test = vi.fn(() => true)

      const di = new CaffeineIoC({ decorators: false })
      di.bindConfig({})
      di.bind(kMixed, t => t.toValue('mixed').conditional(c => [c.present(kUnbound), c.config(test)]))
      await di.init()

      expect(test).toHaveBeenCalledTimes(1)
      expect(di.has(kMixed)).toBe(false)
    })

    it('should refuse a binding made while conditions are decided', async function () {
      const kGuarded = token<string>(Symbol('cond-guarded'))
      const kLate = token<string>(Symbol('cond-late'))

      const di = new CaffeineIoC({ decorators: false })
      di.bindConfig({})
      di.bind(kGuarded, t =>
        t.toValue('guarded').conditional(
          $cond.config(() => {
            di.bind(kLate, late => late.toValue('late'))
            return true
          }),
        ),
      )

      await expect(di.init()).rejects.toThrow(ErrInvalidContainerState)
    })
  })

  describe('using on configuration class', function () {
    describe('and using the decorator on class level', function () {
      const spy1 = vi.fn()
      const spy2 = vi.fn()

      // A config test that counts its calls, to tell which conditions are decided.
      const counted = (spy: () => void, result: boolean) =>
        $cond.config(() => {
          spy()
          return result
        })

      const kTxt = token<string>(Symbol('txt'))
      const kVal = token<string>(Symbol('val'))
      const kJSON = token<string>(Symbol('json'))
      const kXML = token<string>(Symbol('xml'))

      @Configuration()
      @Profile('cond-class-and-method')
      @Conditional(counted(spy1, false))
      class NoConf {
        @Provides(kTxt)
        @Conditional(counted(spy1, true))
        txt() {
          return 'txt'
        }

        @Provides(kVal)
        val() {
          return 'val'
        }
      }

      @Configuration()
      @Profile('cond-class-and-method')
      @Conditional(counted(spy2, true))
      class Conf {
        @Provides(kJSON)
        @Conditional(counted(spy2, true))
        @Conditional(counted(spy2, true))
        json() {
          return 'json'
        }

        @Provides(kXML)
        @Conditional(counted(spy2, false))
        @Conditional(counted(spy2, true))
        xml() {
          return 'xml'
        }
      }

      beforeEach(() => {
        spy1.mockReset()
        spy2.mockReset()
      })

      it('should merge the conditions from class and method level', async function () {
        const di = new CaffeineIoC({ profiles: ['cond-class-and-method'] })
        di.bindConfig({})
        await di.init()

        expect(di.has(NoConf)).toBeFalsy()
        expect(di.has(kTxt)).toBeFalsy()
        expect(di.has(kVal)).toBeFalsy()
        expect(spy1).toHaveBeenCalledTimes(1)

        expect(di.has(Conf)).toBeTruthy()
        expect(di.has(kJSON)).toBeTruthy()
        expect(di.has(kXML)).toBeFalsy()
        expect(spy2).toHaveBeenCalledTimes(4)
      })
    })
  })
})
