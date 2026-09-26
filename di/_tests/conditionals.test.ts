import { describe, it, afterEach, beforeEach, expect, vi } from 'vitest'

import { $cond, type ConditionHelpers } from '../conditional.js'
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
  ErrInvalidContainerState,
  ErrInvalidDecorator,
  ErrMissingInjectionKey,
  ErrNoConfigProvider,
} from '../errors.js'
import { $i } from '../injection.js'
import { token } from '../key.js'
import { mod } from '../module.js'
import { Scopes } from '../scope.js'

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
})

// #49: a binding whose condition checks for a key is decided after every held binding answering to that key, whichever
// order they were declared or bound in.
describe('decision order', function () {
  describe('a decorated default declared before a conditional competitor', function () {
    abstract class Store {
      abstract kind(): string
    }

    @Conditional(c => c.missing(Store))
    @Injectable()
    @Extends()
    class MemoryStore extends Store {
      kind(): string {
        return 'memory'
      }
    }

    @Conditional(c => c.when(() => true))
    @Injectable()
    @Extends()
    class RedisStore extends Store {
      kind(): string {
        return 'redis'
      }
    }
    void RedisStore

    it('yields to the competitor', async function () {
      const di = new CaffeineIoC()
      await di.init()

      expect(di.getMany(Store).map(s => s.kind())).toEqual(['redis'])
      expect(di.has(MemoryStore)).toBe(false)
    })
  })

  describe('a default bound by hand before its competitor', function () {
    abstract class Queue {
      abstract kind(): string
    }

    class MemoryQueue extends Queue {
      kind(): string {
        return 'memory'
      }
    }

    class KafkaQueue extends Queue {
      kind(): string {
        return 'kafka'
      }
    }

    it('yields to the competitor bound after it', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(MemoryQueue, t =>
        t
          .toSelf()
          .extends(Queue)
          .conditional(c => c.missing(Queue)),
      )
      di.bind(KafkaQueue, t =>
        t
          .toSelf()
          .extends(Queue)
          .conditional(c => c.when(() => true)),
      )
      await di.init()

      expect(di.getMany(Queue).map(q => q.kind())).toEqual(['kafka'])
    })
  })

  describe('a chain of defaults and presence checks', function () {
    abstract class DataSource {
      abstract url(): string
    }

    class EmbeddedDataSource extends DataSource {
      url(): string {
        return 'mem://'
      }
    }

    abstract class Repo {
      abstract kind(): string
    }

    class JdbcRepo extends Repo {
      kind(): string {
        return 'jdbc'
      }
    }

    class MemoryRepo extends Repo {
      kind(): string {
        return 'memory'
      }
    }

    // Bound in reverse: each is decided after what it checks for, not in the order it was bound.
    it('decides each binding after the bindings it checks for', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(MemoryRepo, t =>
        t
          .toSelf()
          .extends(Repo)
          .conditional(c => c.missing(Repo)),
      )
      di.bind(JdbcRepo, t =>
        t
          .toSelf()
          .extends(Repo)
          .conditional(c => c.present(DataSource)),
      )
      di.bind(DataSource, t => t.toClass(EmbeddedDataSource).conditional(c => c.missing(DataSource)))
      await di.init()

      expect(di.get(DataSource).url()).toBe('mem://')
      expect(di.getMany(Repo).map(r => r.kind())).toEqual(['jdbc'])
    })
  })

  describe('two defaults of one key', function () {
    abstract class Cache {
      abstract kind(): string
    }

    class FirstCache extends Cache {
      kind(): string {
        return 'first'
      }
    }

    class SecondCache extends Cache {
      kind(): string {
        return 'second'
      }
    }

    // Each waits for the other, so the first declared goes first and the second then sees it.
    it('registers the one declared first, which the other then yields to', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(FirstCache, t =>
        t
          .toSelf()
          .extends(Cache)
          .conditional(c => c.missing(Cache)),
      )
      di.bind(SecondCache, t =>
        t
          .toSelf()
          .extends(Cache)
          .conditional(c => c.missing(Cache)),
      )
      await di.init()

      expect(di.get(Cache).kind()).toBe('first')
    })
  })

  describe('a @Configuration whose condition checks for a key it provides', function () {
    const kGreeting = token<string>(Symbol('default-greeting'))
    const kFarewell = token<string>(Symbol('default-farewell'))

    @Configuration()
    @Conditional(c => c.missing(kGreeting))
    class DefaultGreeting {
      @Provides(kGreeting)
      greeting(): string {
        return 'default'
      }
    }
    void DefaultGreeting

    @Configuration()
    @Conditional(c => c.missing(kFarewell))
    class DefaultFarewell {
      @Provides(kFarewell)
      farewell(): string {
        return 'default'
      }
    }

    it('registers when nothing else answers to the key', async function () {
      const di = new CaffeineIoC()
      await di.init()

      expect(di.get(kGreeting)).toBe('default')
    })

    it('yields, class and all, to a conditional binding of the key made by hand', async function () {
      const di = new CaffeineIoC()
      di.bind(kFarewell, t => t.toValue('hand').conditional(c => c.when(() => true)))
      await di.init()

      expect(di.get(kFarewell)).toBe('hand')
      expect(di.has(DefaultFarewell)).toBe(false)
    })
  })
})

describe('config conditions', function () {
  type Cfg = { cache: { enabled: boolean; kind: string } }
  const config: Cfg = { cache: { enabled: true, kind: 'redis' } }

  class Enabled {}
  class ByPath {}
  class OnRedis {}
  class OnMemcached {}

  it('passes on true, or on the expected value, read by a selector or a path', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bindConfigProvider<Cfg>(t => t.toValue(config))
    di.bind(Enabled, t => t.toSelf().conditional(c => c.config<Cfg>(cfg => cfg.cache.enabled)))
    di.bind(ByPath, t => t.toSelf().conditional(c => c.config('cache.enabled')))
    di.bind(OnRedis, t => t.toSelf().conditional(c => c.config<Cfg, string>(cfg => cfg.cache.kind, 'redis')))
    di.bind(OnMemcached, t => t.toSelf().conditional(c => c.config('cache.kind', 'memcached')))
    await di.init()

    expect([di.has(Enabled), di.has(ByPath), di.has(OnRedis), di.has(OnMemcached)]).toEqual([true, true, true, false])
  })

  it('reads a provider bound with a transient factory, the way std binds it', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bindConfigProvider<Cfg>(t => t.toFactory(() => config).lifetime(Scopes.TRANSIENT))
    di.bind(OnRedis, t => t.toSelf().conditional(c => c.config('cache.kind', 'redis')))
    await di.init()

    expect(di.has(OnRedis)).toBe(true)
  })

  it('fails the container when no config provider is bound', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Enabled, t => t.toSelf().conditional(c => c.config('cache.enabled')))

    await expect(di.init()).rejects.toThrow(ErrNoConfigProvider)
  })

  it('refuses a provider that would need compiling to be read', async function () {
    class ProviderClass {
      readonly cache = { enabled: true }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bindConfigProvider<ProviderClass>(t => t.toClass(ProviderClass))
    di.bind(Enabled, t => t.toSelf().conditional(c => c.config('cache.enabled')))

    await expect(di.init()).rejects.toThrow(ErrInvalidBinding)
  })

  it('waits for a config provider that is itself held back', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Enabled, t => t.toSelf().conditional(c => c.config('cache.enabled')))
    di.bindConfigProvider<Cfg>(t => t.toValue(config).conditional(c => c.when(() => true)))
    await di.init()

    expect(di.has(Enabled)).toBe(true)
  })
})

describe('env conditions', function () {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const kEmpty = token<string>('cond-env-empty')
  const kUnset = token<string>('cond-env-unset')
  const kOther = token<string>('cond-env-other')

  class WhenSet {}
  class WhenEqual {}

  it('passes when the variable is set to a non-empty value, or equals the expected one', async function () {
    vi.stubEnv('CAFFEINE_DI_COND_SET', 'yes')
    vi.stubEnv('CAFFEINE_DI_COND_EMPTY', '')

    const di = new CaffeineIoC({ decorators: false })
    di.bind(WhenSet, t => t.toSelf().conditional(c => c.env('CAFFEINE_DI_COND_SET')))
    di.bind(kEmpty, t => t.toValue('x').conditional(c => c.env('CAFFEINE_DI_COND_EMPTY')))
    di.bind(kUnset, t => t.toValue('x').conditional(c => c.env('CAFFEINE_DI_COND_NEVER_SET')))
    di.bind(WhenEqual, t => t.toSelf().conditional(c => c.env('CAFFEINE_DI_COND_SET', 'yes')))
    di.bind(kOther, t => t.toValue('x').conditional(c => c.env('CAFFEINE_DI_COND_SET', 'no')))
    await di.init()

    expect([di.has(WhenSet), di.has(kEmpty), di.has(kUnset), di.has(WhenEqual), di.has(kOther)]).toEqual([
      true,
      false,
      false,
      true,
      false,
    ])
  })
})

describe('when conditions', function () {
  class Absent {}

  it('calls the predicate with nothing, the container included', async function () {
    const test = vi.fn(() => true)
    class Checked {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Checked, t => t.toSelf().conditional(c => c.when(test)))
    await di.init()

    expect(test).toHaveBeenCalledTimes(1)
    expect(test).toHaveBeenCalledWith()
    expect(di.has(Checked)).toBe(true)
  })

  it('runs only once every condition the container checks itself has passed', async function () {
    const test = vi.fn(() => true)
    class Gated {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Gated, t =>
      t
        .toSelf()
        .conditional(c => c.when(test))
        .conditional(c => c.present(Absent)),
    )
    await di.init()

    expect(test).not.toHaveBeenCalled()
    expect(di.has(Gated)).toBe(false)
  })
})

describe('the forms a condition is given in', function () {
  class Anchor {}
  class ByCondition {}
  class ByCallback {}
  class ByArray {}

  it('takes a condition, a callback handed the helpers, or several conditions', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Anchor, t => t.toSelf())
    di.bind(ByCondition, t => t.toSelf().conditional($cond.present(Anchor)))
    di.bind(ByCallback, t => t.toSelf().conditional(c => c.present(Anchor)))
    di.bind(ByArray, t => t.toSelf().conditional([$cond.present(Anchor), $cond.when(() => false)]))
    await di.init()

    expect([di.has(ByCondition), di.has(ByCallback), di.has(ByArray)]).toEqual([true, true, false])
  })

  // What a binding holds is the data the callback returned, so compile() never calls it again.
  it('runs a callback once, when the condition is declared', async function () {
    const callback = vi.fn((c: ConditionHelpers) => c.when(() => true))
    class Declared {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Declared, t => t.toSelf().conditional(callback))
    expect(callback).toHaveBeenCalledTimes(1)

    await di.init()
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('rejects a predicate written for the old API, or anything else that is not a condition', function () {
    class Old {}
    const di = new CaffeineIoC({ decorators: false })
    const readsTheContainer = (ctx: { container: { has(key: unknown): boolean } }) => ctx.container.has(Old)

    expect(() => di.bind(Old, t => t.toSelf().conditional((() => true) as never))).toThrow(ErrInvalidBinding)
    expect(() => di.bind(Old, t => t.toSelf().conditional(readsTheContainer as never))).toThrow(ErrInvalidBinding)
    expect(() => di.bind(Old, t => t.toSelf().conditional({ kind: 'unknown' } as never))).toThrow(ErrInvalidBinding)
    expect(() => Conditional((() => true) as never)).toThrow(ErrInvalidDecorator)
  })

  it('lets a helper report its own error', function () {
    expect(() => Conditional(c => c.missing(undefined as never))).toThrow(ErrMissingInjectionKey)
  })
})

describe('conditions from a metadata reader', function () {
  abstract class ReadHasher {
    abstract kind(): string
  }

  class ScryptReadHasher extends ReadHasher {
    kind(): string {
      return 'scrypt'
    }
  }

  class ArgonReadHasher extends ReadHasher {
    kind(): string {
      return 'argon'
    }
  }

  const reader = (key: unknown) => (key === ReadHasher ? { conditionals: [$cond.missing(ReadHasher)] } : {})

  // Read when the binding is held rather than when it registers, the reader's condition never sees its own binding:
  // registered first and checked after, a default removed itself.
  it('makes a binding a default that registers when nothing else answers to its key', async function () {
    const di = new CaffeineIoC({ decorators: false, metadataReader: reader })
    di.bind(ReadHasher, t => t.toClass(ScryptReadHasher))
    await di.init()

    expect(di.get(ReadHasher).kind()).toBe('scrypt')
  })

  it('makes it yield to another binding of the key', async function () {
    const di = new CaffeineIoC({ decorators: false, metadataReader: reader })
    di.bind(ReadHasher, t => t.toClass(ScryptReadHasher))
    di.bind(ArgonReadHasher, t => t.toSelf().extends(ReadHasher))
    await di.init()

    expect(di.getMany(ReadHasher).map(h => h.kind())).toEqual(['argon'])
  })
})

describe('snapshot() and restore()', function () {
  it('restores a registered binding as it is, without deciding its conditions again', async function () {
    let enabled = true
    class Flagged {}

    const source = new CaffeineIoC({ decorators: false })
    source.bind(Flagged, t => t.toSelf().conditional(c => c.when(() => enabled)))
    await source.init()

    enabled = false

    const di = new CaffeineIoC({ decorators: false })
    di.restore(source.snapshot())
    await di.init()

    expect(di.has(Flagged)).toBe(true)
  })

  it('decides a binding the source still held with the profiles the source had active', async function () {
    class HeldForProfile {}

    const source = new CaffeineIoC({ decorators: false, profiles: ['snap-held'] })
    source.bind(HeldForProfile, t => t.toSelf().profiles('snap-held'))

    const di = new CaffeineIoC({ decorators: false })
    di.restore(source.snapshot())
    await di.init()

    expect(di.profiles.has('snap-held')).toBe(true)
    expect(di.has(HeldForProfile)).toBe(true)
  })

  // What a from-scratch TestContainer does: both containers read the same decorators, and hold the same bindings.
  it('does not hold a binding twice when the container restored into read the same decorators', async function () {
    const di = new CaffeineIoC()
    di.restore(new CaffeineIoC().snapshot())

    await expect(di.init()).resolves.toBeUndefined()
  })

  it('cannot restore once the container has been compiled', async function () {
    const di = new CaffeineIoC({ decorators: false })
    await di.compile()

    expect(() => di.restore(new CaffeineIoC({ decorators: false }).snapshot())).toThrow(ErrInvalidContainerState)
  })
})
