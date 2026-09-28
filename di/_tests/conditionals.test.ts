import { describe, it, afterEach, beforeEach, expect, vi } from 'vitest'

import { $cond, type Condition } from '../conditional.js'
import { CaffeineIoC } from '../container.js'
import { ContainerBindingOps } from '../container_interface.js'
import { Conditional } from '../decorators/conditional.js'
import { Configuration } from '../decorators/configuration.js'
import { Extends } from '../decorators/extends.js'
import { Injectable } from '../decorators/injectable.js'
import { Profile } from '../decorators/profile.js'
import { Provides } from '../decorators/provides.js'
import {
  ErrInvalidBinding,
  ErrInvalidDecorator,
  ErrMissingInjectionKey,
  ErrNoValuesProvider,
  ErrRepeatedInjectableConfiguration,
} from '../errors.js'
import { $i } from '../injection.js'
import { token } from '../key.js'
import { mod } from '../module.js'

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
    @Conditional(c => c.when(() => true))
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

    it('should only register components that pass all provided conditionals', async function () {
      const di = new CaffeineIoC()

      expect(di.has(Pass)).toBeFalsy()
      expect(di.has(NoPass)).toBeFalsy()
      expect(di.has(NoPassToo)).toBeFalsy()

      await di.init()

      expect(di.has(Pass)).toBeTruthy()
      expect(di.has(NoPass)).toBeFalsy()
      expect(di.has(NoPassToo)).toBeFalsy()
    })

    it('should resolve components that pass conditionals and handle optional absent deps', async function () {
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

  describe('async conditional functions', function () {
    it('should register a component when an async conditional resolves to true', async function () {
      @Injectable()
      @Conditional(c => c.when(async () => true))
      class AsyncTrueBean {}

      const di = new CaffeineIoC()
      await di.init()

      expect(di.has(AsyncTrueBean)).toBeTruthy()
    })

    it('should not register a component when an async conditional resolves to false', async function () {
      @Injectable()
      @Conditional(c => c.when(async () => false))
      class AsyncFalseBean {}

      const di = new CaffeineIoC()
      await di.init()

      expect(di.has(AsyncFalseBean)).toBeFalsy()
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
      di.bind(kChannel, t => t.toClass(FailingChannel).conditional(c => c.when(() => false)))
      di.bind(NamedChannel, t => t.toSelf().names(kChannel))
      await di.init()

      expect(di.get(kChannel).kind()).toBe('named')
    })

    it('should support async conditional functions', async function () {
      class AsyncConditionalSvc {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(AsyncConditionalSvc, t => t.toSelf().conditional(c => c.when(async () => true)))
      await di.init()

      expect(di.has(AsyncConditionalSvc)).toBeTruthy()
      expect(di.get(AsyncConditionalSvc)).toBeInstanceOf(AsyncConditionalSvc)
    })

    // A binding made by hand waits for compile() like a decorated one. Registered at bind time, it replaced a binding of
    // its key before its condition ran, so a default written as `.conditional(c => c.missing(key))` took the
    // application's own binding with it.
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
        di.bind(ScryptHasher, t => t.toSelf().conditional(c => c.when(() => true)))

        expect(di.has(ScryptHasher)).toBe(false)

        await di.init()

        expect(di.has(ScryptHasher)).toBe(true)
      })

      it('should be discarded by a later binding of the same key, as a registered one is replaced', async function () {
        const di = new CaffeineIoC({ decorators: false })
        di.bind(Hasher, t => t.toClass(ScryptHasher).conditional(c => c.when(() => true)))
        di.bind(Hasher, t => t.toClass(ArgonHasher))
        await di.init()

        expect(di.get(Hasher).kind()).toBe('argon')
      })

      it('should leave the earlier binding of its key in place when its condition fails', async function () {
        const di = new CaffeineIoC({ decorators: false })
        di.bind(Hasher, t => t.toClass(ArgonHasher))
        di.bind(Hasher, t => t.toClass(ScryptHasher).conditional(c => c.when(() => false)))
        await di.init()

        expect(di.get(Hasher).kind()).toBe('argon')
      })

      it('should still be matched against the active profiles', async function () {
        const di = new CaffeineIoC({ decorators: false, profiles: ['prod'] })
        di.bind(ScryptHasher, t =>
          t
            .toSelf()
            .profiles('test')
            .conditional(c => c.when(() => true)),
        )
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
      @Conditional(c => c.when(() => false))
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
      @Conditional(c => c.when(() => true))
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

  // A @Provides waits for the class that declares it, never for another class that provides the same key: tied by key,
  // one failing class took every @Provides of that key down with it.
  describe('a @Provides tied to its own configuration class', function () {
    const kShared = token<string>(Symbol('shared-provide'))
    const kDecidedApart = token<string>(Symbol('decided-apart-provide'))
    const kTwice = token<string>(Symbol('twice-provide'))

    @Configuration()
    @Conditional(c => c.when(() => false))
    @Profile('provides-own-class')
    class FailingProvider {
      @Provides(kShared)
      value(): string {
        return 'failing'
      }
    }

    @Configuration()
    @Profile('provides-own-class')
    class PlainProvider {
      @Provides(kShared)
      value(): string {
        return 'plain'
      }
    }

    @Configuration()
    @Conditional(c => c.when(() => false))
    @Profile('provides-decided-apart')
    class FailingFirst {
      @Provides(kDecidedApart)
      value(): string {
        return 'failing'
      }
    }

    @Configuration()
    @Conditional(c => c.when(() => true))
    @Profile('provides-decided-apart')
    class PassingSecond {
      @Provides(kDecidedApart)
      value(): string {
        return 'passing'
      }
    }

    @Configuration()
    @Conditional(c => c.when(() => true))
    @Profile('provides-twice')
    class PendingProvider {
      @Provides(kTwice)
      value(): string {
        return 'pending'
      }
    }

    @Configuration()
    @Profile('provides-twice')
    class FirstProvider {
      @Provides(kTwice)
      value(): string {
        return 'first'
      }
    }

    @Configuration()
    @Profile('provides-twice')
    class SecondProvider {
      @Provides(kTwice)
      value(): string {
        return 'second'
      }
    }

    void [FailingProvider, PlainProvider, FailingFirst, PassingSecond, PendingProvider, FirstProvider, SecondProvider]

    it('should keep the @Provides of an unconditional class when another class providing its key fails', async function () {
      const di = new CaffeineIoC({ profiles: ['provides-own-class'] })
      await di.init()

      expect(di.get(kShared)).toBe('plain')
    })

    it('should keep it when both classes wait for a profile added after construction', async function () {
      const di = new CaffeineIoC()
      di.addProfiles('provides-own-class')
      await di.init()

      expect(di.get(kShared)).toBe('plain')
    })

    it('should decide the @Provides of a conditional class by its own class, not the first one providing its key', async function () {
      const di = new CaffeineIoC({ profiles: ['provides-decided-apart'] })
      await di.init()

      expect(di.get(kDecidedApart)).toBe('passing')
    })

    // Tied to the pending class by key, the two used to wait for it and hide that they provide the same key.
    it('should refuse two unconditional @Provides of one key beside a conditional class providing it', function () {
      expect(() => new CaffeineIoC({ profiles: ['provides-twice'] })).toThrow(ErrRepeatedInjectableConfiguration)
    })

    // A @Provides keyed by a configuration class provides a binding of that key; it is not the class. Its passing must
    // not let the @Provides of the class through: GatedConf waits for the gate, and fails.
    it('should skip the @Provides of a failing class when a @Provides of the class key passed', async function () {
      const kGate = token<string>(Symbol('class-key-gate'))
      const kValue = token<string>(Symbol('class-key-value'))

      @Configuration()
      @Conditional(c => c.present(kGate))
      @Profile('provides-class-key')
      class GatedConf {
        @Provides(kValue)
        value(): string {
          return 'gated'
        }
      }

      @Configuration()
      @Conditional(c => c.when(() => true))
      @Profile('provides-class-key')
      class ClassKeyConf {
        @Provides(GatedConf)
        gated(): GatedConf {
          return new GatedConf()
        }
      }
      void ClassKeyConf

      const di = new CaffeineIoC({ profiles: ['provides-class-key'] })
      di.bind(kGate, t => t.toValue('gate').conditional(c => c.when(() => false)))
      await di.init()

      expect(di.has(kValue)).toBe(false)
    })

    // A conditional @Provides of an unconditional class is decided with the configuration classes, but it is not one.
    // Keyed by a held class, it must not take that class's @Provides as its own.
    it('should decide the @Provides of a class once, by that class, when a conditional @Provides of another class provides the class key', async function () {
      const kGate = token<string>(Symbol('class-key-late-gate'))
      const kValue = token<string>(Symbol('class-key-late-value'))

      @Configuration()
      @Conditional(c => c.present(kGate))
      @Profile('provides-class-key-late')
      class LateGatedConf {
        @Provides(kValue)
        value(): string {
          return 'gated'
        }
      }

      @Configuration()
      @Profile('provides-class-key-late')
      class ClassKeyProvider {
        @Provides(LateGatedConf)
        @Conditional(c => c.when(() => false))
        gated(): LateGatedConf {
          return new LateGatedConf()
        }
      }
      void ClassKeyProvider

      const decisions: string[] = []
      const di = new CaffeineIoC({ profiles: ['provides-class-key-late'] })
      di.hooks.on('onBindingRegistered', ({ key }) => {
        if (key === kValue) {
          decisions.push('registered')
        }
      })
      di.hooks.on('onBindingNotRegistered', ({ key }) => {
        if (key === kValue) {
          decisions.push('not registered')
        }
      })
      di.bind(kGate, t => t.toValue('gate').conditional(c => c.when(() => true)))
      await di.init()

      expect(di.get(kValue)).toBe('gated')
      expect(decisions).toEqual(['registered'])
    })

    // Only the class itself goes without waiting for its own @Provides. A @Provides keyed by the class still waits for
    // the ones it checks: decided first, this fallback would register beside WaitedConf and clash with it.
    it('should let a @Provides keyed by a held class wait for the @Provides of that class it checks', async function () {
      const kGate = token<string>(Symbol('class-key-wait-gate'))
      const kValue = token<string>(Symbol('class-key-wait-value'))

      @Configuration()
      @Conditional(c => c.present(kGate))
      @Profile('provides-class-key-wait')
      class WaitedConf {
        @Provides(kValue)
        value(): string {
          return 'waited'
        }
      }

      @Configuration()
      @Profile('provides-class-key-wait')
      class FallbackProvider {
        @Provides(WaitedConf)
        @Conditional(c => c.missing(kValue))
        fallback(): WaitedConf {
          return new WaitedConf()
        }
      }
      void FallbackProvider

      const di = new CaffeineIoC({ profiles: ['provides-class-key-wait'] })
      di.bind(kGate, t => t.toValue('gate').conditional(c => c.when(() => true)))
      await di.init()

      expect(di.get(kValue)).toBe('waited')
    })
  })

  // A present or missing condition is decided after every held binding answering to the key it checks, so a default
  // yields to a conditional competitor however the two were declared. Decided in declaration order, a default saw
  // only the competitors decided before it, registered next to a later one, and resolving the key failed.
  describe('decision order', function () {
    abstract class Store {
      abstract kind(): string
    }

    @Conditional(c => c.missing(Store))
    @Injectable()
    @Extends()
    @Profile('order-decorated')
    class DecoratedDefault extends Store {
      kind(): string {
        return 'memory'
      }
    }

    @Conditional(c => c.when(() => true))
    @Injectable()
    @Extends()
    @Profile('order-decorated')
    class DecoratedCompetitor extends Store {
      kind(): string {
        return 'redis'
      }
    }

    @Conditional(c => c.missing(Store))
    @Injectable()
    @Extends()
    @Profile('order-hand-competitor')
    class DecoratedDefaultBeforeHand extends Store {
      kind(): string {
        return 'memory'
      }
    }

    class HandDefault extends Store {
      kind(): string {
        return 'memory'
      }
    }

    class HandCompetitor extends Store {
      kind(): string {
        return 'redis'
      }
    }

    class OtherDefault extends Store {
      kind(): string {
        return 'other'
      }
    }

    void [DecoratedDefault, DecoratedCompetitor, DecoratedDefaultBeforeHand]

    const bindDefault = (di: CaffeineIoC, cls: new () => Store = HandDefault) =>
      di.bind(cls, t =>
        t
          .toSelf()
          .extends(Store)
          .conditional(c => c.missing(Store)),
      )
    const bindCompetitor = (di: CaffeineIoC, passes = true) =>
      di.bind(HandCompetitor, t =>
        t
          .toSelf()
          .extends(Store)
          .conditional(c => c.when(() => passes)),
      )

    it('should let a decorated default yield to a conditional decorated class declared after it', async function () {
      const di = new CaffeineIoC({ profiles: ['order-decorated'] })
      await di.init()

      expect(di.getMany(Store).map(s => s.kind())).toEqual(['redis'])
    })

    it('should let a decorated default yield to a conditional binding made by hand', async function () {
      const di = new CaffeineIoC({ profiles: ['order-hand-competitor'] })
      bindCompetitor(di)
      await di.init()

      expect(di.getMany(Store).map(s => s.kind())).toEqual(['redis'])
    })

    it('should let a default bound by hand yield to a conditional binding bound after it', async function () {
      const di = new CaffeineIoC({ decorators: false })
      bindDefault(di)
      bindCompetitor(di)
      await di.init()

      expect(di.getMany(Store).map(s => s.kind())).toEqual(['redis'])
    })

    it('should register a default when its conditional competitor fails', async function () {
      const di = new CaffeineIoC({ decorators: false })
      bindDefault(di)
      bindCompetitor(di, false)
      await di.init()

      expect(di.getMany(Store).map(s => s.kind())).toEqual(['memory'])
    })

    // A binding never waits for itself. A default checking its own key would otherwise be put off until nothing else
    // could go, and decided after bindings declared later that it has nothing to do with.
    it('should decide a default in declaration order among bindings it does not wait for', async function () {
      class Audit {}

      const decided: string[] = []
      const record = (name: string) => () => {
        decided.push(name)
        return true
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(HandDefault, t =>
        t
          .toSelf()
          .extends(Store)
          .conditional([$cond.missing(Store), $cond.when(record('default'))]),
      )
      di.bind(Audit, t => t.toSelf().conditional(c => c.when(record('audit'))))
      await di.init()

      expect(decided).toEqual(['default', 'audit'])
    })

    // Two defaults of one key wait for each other. The cycle is decided in declaration order: the first registers,
    // and the second sees it and yields.
    it('should register only the first declared of two defaults of one key', async function () {
      const di = new CaffeineIoC({ decorators: false })
      bindDefault(di, OtherDefault)
      bindDefault(di)
      await di.init()

      expect(di.getMany(Store).map(s => s.kind())).toEqual(['other'])
    })

    // Stats waits on the two defaults, which wait on each other. Forcing the earliest undecided binding would decide
    // Stats first, before any Store exists; the cycle is what gets broken, and Stats is decided after it.
    it('should decide a binding waiting on a cycle after the cycle', async function () {
      class Stats {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Stats, t => t.toSelf().conditional(c => c.present(Store)))
      bindDefault(di, OtherDefault)
      bindDefault(di)
      await di.init()

      expect(di.has(Stats)).toBe(true)
      expect(di.getMany(Store).map(s => s.kind())).toEqual(['other'])
    })

    // The binding forced to break the cycle is freed again once the other default is decided, while Stats, waiting on
    // both, is still to go. It must not be decided a second time.
    it('should decide each condition once when a cycle is broken', async function () {
      class Stats {}

      const decide = vi.fn(() => true)

      const di = new CaffeineIoC({ decorators: false })
      di.bind(OtherDefault, t =>
        t
          .toSelf()
          .extends(Store)
          .conditional([$cond.missing(Store), $cond.when(decide)]),
      )
      bindDefault(di)
      di.bind(Stats, t => t.toSelf().conditional(c => c.present(Store)))
      await di.init()

      expect(decide).toHaveBeenCalledTimes(1)
      expect(di.has(Stats)).toBe(true)
      expect(di.getMany(Store).map(s => s.kind())).toEqual(['other'])
    })

    // Two cycles meet at the primary @Provides: one through FallbackConf, one through its own class and the guard.
    // Walking them, the @Provides leads to its class first, so PrimaryConf is decided before anything is guessed about
    // the probe, the probe sees it, and FallbackConf yields. Led to FallbackConf instead, the walk would decide it as
    // if the probe were absent, and it would stay registered beside the probe its condition says must be missing.
    it('should break a cycle through a @Provides at its class', async function () {
      const kPrimary = token<string>(Symbol('order-via-class-primary'))
      const kFallback = token<string>(Symbol('order-via-class-fallback'))
      const kGuard = token<string>(Symbol('order-via-class-guard'))
      const kProbe = token<string>(Symbol('order-via-class-probe'))

      @Configuration()
      @Conditional(c => c.missing(kPrimary))
      @Conditional(c => c.missing(kProbe))
      @Profile('order-via-class')
      class FallbackConf {
        @Provides(kFallback)
        fallback(): string {
          return 'fallback'
        }
      }

      @Configuration()
      @Conditional(c => c.missing(kGuard))
      @Profile('order-via-class')
      class PrimaryConf {
        @Provides(kPrimary)
        @Conditional(c => c.missing(kFallback))
        primary(): string {
          return 'primary'
        }
      }

      const di = new CaffeineIoC({ profiles: ['order-via-class'] })
      di.bind(kGuard, t => t.toValue('guard').conditional(c => c.missing(kPrimary)))
      di.bind(kProbe, t => t.toValue('probe').conditional(c => c.present(PrimaryConf)))
      await di.init()

      expect(di.get(kPrimary)).toBe('primary')
      expect(di.has(kProbe)).toBe(true)
      expect(di.has(FallbackConf)).toBe(false)
      expect(di.has(kFallback)).toBe(false)
      expect(di.has(kGuard)).toBe(false)
    })

    it('should decide a @Provides after the held binding its condition checks', async function () {
      const kReport = token<string>(Symbol('order-report'))

      class Metrics {}

      @Configuration()
      @Profile('order-provides')
      class ReportConf {
        @Provides(kReport)
        @Conditional(c => c.present(Metrics))
        report(): string {
          return 'report'
        }
      }
      void ReportConf

      const di = new CaffeineIoC({ profiles: ['order-provides'] })
      di.bind(Metrics, t => t.toSelf().conditional(c => c.when(() => true)))
      await di.init()

      expect(di.get(kReport)).toBe('report')
    })

    // Decided before its class, a @Provides would find the class not passed yet and be left out.
    it('should decide a @Provides after its class when the class waits for a later binding', async function () {
      const kLog = token<string>(Symbol('order-class-waits'))

      class Sink {}

      @Configuration()
      @Conditional(c => c.present(Sink))
      @Profile('order-class-waits')
      class LogConf {
        @Provides(kLog)
        log(): string {
          return 'log'
        }
      }
      void LogConf

      const di = new CaffeineIoC({ profiles: ['order-class-waits'] })
      di.bind(Sink, t => t.toSelf().conditional(c => c.when(() => true)))
      await di.init()

      expect(di.get(kLog)).toBe('log')
    })

    // A class whose condition checks a key it provides is a default for that key: it waits for every other binding
    // answering to the key, but never for its own @Provides.
    it('should let a configuration class providing a key it checks yield to a competitor of that key', async function () {
      const kSource = token<string>(Symbol('order-source'))

      @Configuration()
      @Conditional(c => c.missing(kSource))
      @Profile('order-autoconfig')
      class DefaultSourceConf {
        @Provides(kSource)
        source(): string {
          return 'default'
        }
      }

      const di = new CaffeineIoC({ profiles: ['order-autoconfig'] })
      di.bind(kSource, t => t.toValue('application').conditional(c => c.when(() => true)))
      await di.init()

      expect(di.get(kSource)).toBe('application')
      expect(di.has(DefaultSourceConf)).toBe(false)
    })

    // Waiting on its own @Provides, the class would form a cycle with it and be decided there, before a competitor that
    // still waits on a cycle of its own.
    it('should let a configuration class yield to a competitor waiting on another cycle', async function () {
      const kSource = token<string>(Symbol('order-cycle-source'))
      const kA = token<string>(Symbol('order-cycle-a'))
      const kB = token<string>(Symbol('order-cycle-b'))

      @Configuration()
      @Conditional(c => c.missing(kSource))
      @Profile('order-autoconfig-cycle')
      class CycleDefaultSourceConf {
        @Provides(kSource)
        source(): string {
          return 'default'
        }
      }

      const di = new CaffeineIoC({ profiles: ['order-autoconfig-cycle'] })
      di.bind(kSource, t => t.toValue('application').conditional(c => c.present(kB)))
      di.bind(kB, t => t.toValue('b').conditional(c => c.missing(kA)))
      di.bind(kA, t => t.toValue('a').conditional(c => c.missing(kB)))
      await di.init()

      expect(di.get(kSource)).toBe('application')
      expect(di.has(CycleDefaultSourceConf)).toBe(false)
    })

    // A config condition reads the values provider, so it waits for a provider still held for its own conditions.
    it('should decide a config condition after a values provider held for its conditions', async function () {
      class Cached {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Cached, t => t.toSelf().conditional(c => c.config('cache.enabled')))
      di.bindValuesProvider(t => t.toValue({ cache: { enabled: true } }).conditional(c => c.when(() => true)))
      await di.init()

      expect(di.has(Cached)).toBe(true)
    })

    it('should decide a conditional binding made while conditions are decided', async function () {
      class Trigger {}
      class Late {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Trigger, t =>
        t.toSelf().conditional(c =>
          c.when(() => {
            di.bind(Late, l => l.toSelf().conditional(lc => lc.when(() => true)))
            return true
          }),
        ),
      )
      await di.init()

      expect(di.has(Late)).toBe(true)
    })

    // Binding a key again discards a held binding of it, even while conditions are decided: the discarded one must not
    // come back and replace the binding that discarded it.
    it('should not decide a held binding discarded while conditions are decided', async function () {
      const kHeld = token<string>(Symbol('order-discarded'))

      class Trigger {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Trigger, t =>
        t.toSelf().conditional(c =>
          c.when(() => {
            di.bind(kHeld, h => h.toValue('replacement'))
            return true
          }),
        ),
      )
      di.bind(kHeld, t => t.toValue('discarded').conditional(c => c.when(() => true)))
      await di.init()

      expect(di.get(kHeld)).toBe('replacement')
    })
  })

  describe('using on configuration class', function () {
    describe('and using the decorator on class level', function () {
      const spy1 = vi.fn()
      const spy2 = vi.fn()

      const kTxt = token<string>(Symbol('txt'))
      const kVal = token<string>(Symbol('val'))
      const kJSON = token<string>(Symbol('json'))
      const kXML = token<string>(Symbol('xml'))

      @Configuration()
      @Conditional(c =>
        c.when(() => {
          spy1()
          return false
        }),
      )
      class NoConf {
        @Provides(kTxt)
        @Conditional(c =>
          c.when(() => {
            spy1()
            return true
          }),
        )
        txt() {
          return 'txt'
        }

        @Provides(kVal)
        val() {
          return 'val'
        }
      }

      @Configuration()
      @Conditional(c =>
        c.when(() => {
          spy2()
          return true
        }),
      )
      class Conf {
        @Provides(kJSON)
        @Conditional(c =>
          c.when(() => {
            spy2()
            return true
          }),
        )
        @Conditional(c =>
          c.when(() => {
            spy2()
            return true
          }),
        )
        json() {
          return 'json'
        }

        @Provides(kXML)
        @Conditional(c =>
          c.when(() => {
            spy2()
            return false
          }),
        )
        @Conditional(c =>
          c.when(() => {
            spy2()
            return true
          }),
        )
        xml() {
          return 'xml'
        }
      }

      beforeEach(() => {
        spy1.mockReset()
        spy2.mockReset()
      })

      it('should merge the conditionals from class and method level', async function () {
        const di = new CaffeineIoC()
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

  // A condition is data now, so a predicate written for the old API must fail where it is written, not decide
  // silently: `() => false` returns no condition, and `ctx => ctx.container.has(X)` reads a container it is not handed.
  describe('condition input', function () {
    class Target {}

    it('should reject a predicate in @Conditional where the class is decorated', function () {
      expect(() => {
        @Injectable()
        // @ts-expect-error a predicate is not a condition
        @Conditional(() => true)
        class OldStyle {}
        void OldStyle
      }).toThrow(ErrInvalidDecorator)
    })

    it('should reject a predicate reading the container, naming the member it decorates', function () {
      expect(() => {
        @Configuration()
        class OldStyleConf {
          @Provides(token<string>(Symbol('old-style')))
          // @ts-expect-error the callback is handed the condition builders, not a context
          @Conditional(ctx => ctx.container.has(Target))
          value(): string {
            return 'value'
          }
        }
        void OldStyleConf
      }).toThrow(/Cannot apply @Conditional to member "value": the callback threw/)
    })

    it('should reject a predicate in .conditional() when the binding is made', function () {
      const di = new CaffeineIoC({ decorators: false })

      // @ts-expect-error a predicate is not a condition
      expect(() => di.bind(Target, t => t.toSelf().conditional(() => false))).toThrow(ErrInvalidBinding)
    })

    it('should reject a value that is not a condition when the binding is made, not at init()', function () {
      const di = new CaffeineIoC({ decorators: false })

      expect(() => di.bind(Target, t => t.toSelf().conditional({ kind: 'sometimes' } as never))).toThrow(
        /Cannot configure .conditional\(\) for "Target": the argument is not a condition/,
      )
    })

    it('should let an error of a condition builder through the callback unchanged', function () {
      const di = new CaffeineIoC({ decorators: false })

      expect(() => di.bind(Target, t => t.toSelf().conditional(c => c.present(undefined as never)))).toThrow(
        ErrMissingInjectionKey,
      )
    })

    // Left to init(), a null key or an empty variable name would be decided without complaint, and a test that is not
    // a function would fail as a bare TypeError.
    it.each([
      ['present', () => $cond.present(null as never), ErrMissingInjectionKey],
      ['missing', () => $cond.missing(undefined as never), ErrMissingInjectionKey],
      ['config', () => $cond.config(42 as never), ErrInvalidBinding],
      ['env', () => $cond.env(''), ErrInvalidBinding],
      ['when', () => $cond.when('true' as never), ErrInvalidBinding],
    ])('should reject a bad argument to %s when the condition is built', function (name, build, type) {
      expect(build).toThrow(type)
      expect(build).toThrow(new RegExp(`^Cannot build an? ${name} condition: `))
    })

    it('should report what a callback threw when it is not an error', function () {
      const di = new CaffeineIoC({ decorators: false })

      expect(() =>
        di.bind(Target, t =>
          t.toSelf().conditional(() => {
            throw 'no container here'
          }),
        ),
      ).toThrow(/the callback threw "no container here"/)
    })

    it('should take a condition built with $cond as well as a callback', async function () {
      @Injectable()
      @Conditional($cond.when(() => true))
      class Built {}

      const di = new CaffeineIoC()
      await di.init()

      expect(di.has(Built)).toBe(true)
    })

    it('should require every condition given at once to pass', async function () {
      class Both {}
      class OnlyOne {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Target, t => t.toSelf())
      di.bind(Both, t => t.toSelf().conditional([$cond.present(Target), $cond.when(() => true)]))
      di.bind(OnlyOne, t => t.toSelf().conditional([$cond.present(Target), $cond.when(() => false)]))
      await di.init()

      expect(di.has(Both)).toBe(true)
      expect(di.has(OnlyOne)).toBe(false)
    })
  })

  describe('when', function () {
    // Handed nothing, a test cannot reach into the container: a registry check goes through present or missing.
    it('should call the test with no arguments', async function () {
      class Svc {}
      const test = vi.fn(() => true)

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Svc, t => t.toSelf().conditional(c => c.when(test)))
      await di.init()

      expect(test).toHaveBeenCalledWith()
      expect(di.has(Svc)).toBe(true)
    })
  })

  describe('present and missing', function () {
    // A binding must never satisfy or defeat its own condition. A reader merges conditions into a binding that is
    // already registered, so without that rule its missing(key) would see the binding itself and remove it.
    it('should not count the binding being decided', async function () {
      class Svc {}

      const di = new CaffeineIoC({
        decorators: false,
        metadataReader: key => (key === Svc ? { conditionals: [$cond.missing(Svc)] } : {}),
      })
      di.bind(Svc, t => t.toSelf())
      await di.init()

      expect(di.has(Svc)).toBe(true)
    })

    it('should fail init() on a condition that is not data, as a reader written for the old API returns', async function () {
      class Svc {}

      const di = new CaffeineIoC({
        decorators: false,
        metadataReader: key => (key === Svc ? { conditionals: [(() => true) as never] } : {}),
      })
      di.bind(Svc, t => t.toSelf())

      await expect(di.init()).rejects.toThrow(ErrInvalidBinding)
    })
  })

  describe('config', function () {
    type AppConfig = { cache: { kind: string; enabled: boolean }; region: null }

    const values: AppConfig = { cache: { kind: 'redis', enabled: true }, region: null }

    class RedisCache {}

    async function registers(bindProvider: (di: CaffeineIoC) => void, condition: Condition) {
      const di = new CaffeineIoC({ decorators: false })
      bindProvider(di)
      di.bind(RedisCache, t => t.toSelf().conditional(condition))
      await di.init()

      return di.has(RedisCache)
    }

    const withValues = (di: CaffeineIoC) => di.bindValuesProvider<AppConfig>(t => t.toValue(values))

    it('should register a binding when the value at a path equals the expected one', async function () {
      expect(await registers(withValues, $cond.config('cache.kind', 'redis'))).toBe(true)
    })

    it('should not register a binding when the value differs from the expected one', async function () {
      expect(await registers(withValues, $cond.config('cache.kind', 'memory'))).toBe(false)
    })

    it('should read a value through a selector', async function () {
      expect(
        await registers(
          withValues,
          $cond.config<AppConfig>(cfg => cfg.cache.kind, 'redis'),
        ),
      ).toBe(true)
    })

    // Without an expected value the condition is a switch: a truthy string such as 'redis' must not turn it on.
    it('should pass only on true when no expected value is given', async function () {
      expect(await registers(withValues, $cond.config('cache.enabled'))).toBe(true)
      expect(await registers(withValues, $cond.config('cache.kind'))).toBe(false)
    })

    it('should read a provider bound with toFactory()', async function () {
      const withFactory = (di: CaffeineIoC) => di.bindValuesProvider<AppConfig>(t => t.toFactory(() => values))

      expect(await registers(withFactory, $cond.config('cache.kind', 'redis'))).toBe(true)
    })

    // One path reader serves both, so a path that stops at a null link means the same to a condition and an injection.
    it('should read a path the way $i.value does', async function () {
      class Regional {
        constructor(readonly region: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      withValues(di)
      di.bind(Regional, t =>
        t.toClass(Regional, [$i.value('region.name', 'none')]).conditional(c => c.config('region.name', undefined)),
      )
      await di.init()

      expect(di.get(Regional).region).toBe('none')
    })

    it('should fail init() when no values provider is bound', async function () {
      await expect(registers(() => {}, $cond.config('cache.kind', 'redis'))).rejects.toThrow(ErrNoValuesProvider)
    })

    it('should fail init() when the values provider cannot be read before the container compiles', async function () {
      class ClassProvider {
        readonly cache = values.cache
      }

      const withClass = (di: CaffeineIoC) => di.bindValuesProvider(t => t.toClass(ClassProvider))

      await expect(registers(withClass, $cond.config('cache.kind', 'redis'))).rejects.toThrow(ErrInvalidBinding)
    })
  })

  describe('env', function () {
    const name = 'CAFFEINE_DI_CONDITION_ENV'

    class Svc {}

    afterEach(() => {
      vi.unstubAllEnvs()
    })

    async function registers(condition: Condition) {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(Svc, t => t.toSelf().conditional(condition))
      await di.init()

      return di.has(Svc)
    }

    it('should pass when the variable is set and no expected value is given', async function () {
      vi.stubEnv(name, 'on')

      expect(await registers($cond.env(name))).toBe(true)
    })

    it('should fail when the variable is set to an empty string', async function () {
      vi.stubEnv(name, '')

      expect(await registers($cond.env(name))).toBe(false)
    })

    it('should fail when the variable is unset', async function () {
      vi.stubEnv(name, undefined)

      expect(await registers($cond.env(name))).toBe(false)
    })

    it('should pass only when the variable equals the expected value', async function () {
      vi.stubEnv(name, 'eu')

      expect(await registers($cond.env(name, 'eu'))).toBe(true)
      expect(await registers($cond.env(name, 'us'))).toBe(false)
    })

    // Applications set the environment after their classes are decorated, so the variable is read at compile().
    it('should read the variable when the container compiles, not when the condition is built', async function () {
      const condition = $cond.env(name, 'late')
      vi.stubEnv(name, 'late')

      expect(await registers(condition)).toBe(true)
    })
  })
})
