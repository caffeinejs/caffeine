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
import { ErrDuplicateBinding, ErrInvalidBinding, ErrInvalidDecorator, ErrNoValuesProvider } from '../errors.js'
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
