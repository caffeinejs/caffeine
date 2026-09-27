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

// A cycle is decided by forcing its first declared binding out before the bindings it waits for. That settles when
// some order of the cycle holds — two defaults of one key — and the container fails when none does, rather than keep a
// binding its own condition contradicts.
describe('a cycle of conditions across keys', function () {
  class Rock {}
  class Paper {}
  class Scissors {}

  abstract class PluginBase {
    abstract id(): string
  }
  class Plugin extends PluginBase {
    id(): string {
      return 'plugin'
    }
  }
  class SwitchedOffPlugin extends PluginBase {
    id(): string {
      return 'switched-off'
    }
  }
  class BuiltInPlugin extends PluginBase {
    id(): string {
      return 'built-in'
    }
  }
  class Feature {}
  const kPlugins = token<PluginBase>(Symbol('cycle-plugins'))

  it('fails the container when no order of the cycle holds', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Rock, t => t.toSelf().conditional(c => c.missing(Paper)))
    di.bind(Paper, t => t.toSelf().conditional(c => c.missing(Scissors)))
    di.bind(Scissors, t => t.toSelf().conditional(c => c.missing(Rock)))

    const init = di.init()

    await expect(init).rejects.toThrow(ErrInvalidBinding)
    await expect(init).rejects.toThrow(
      /Cannot decide "Rock": its condition missing\("Paper"\) was decided before "Paper"/,
    )
    await expect(init).rejects.toThrow(/Break the cycle/)
  })

  it('fails when a presence check and a default each wait for the other', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Feature, t => t.toSelf().conditional(c => c.present(Plugin)))
    di.bind(Plugin, t => t.toSelf().conditional(c => c.missing(Feature)))

    await expect(di.init()).rejects.toThrow(/Cannot decide "Feature": its condition present\("Plugin"\)/)
  })

  it('follows the cycle through a name', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Feature, t => t.toSelf().conditional(c => c.present(kPlugins)))
    di.bind(Plugin, t =>
      t
        .toSelf()
        .names(kPlugins)
        .conditional(c => c.missing(Feature)),
    )

    await expect(di.init()).rejects.toThrow(/its condition present\("Symbol\(cycle-plugins\)"\)/)
  })

  it('follows the cycle through a base', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Feature, t => t.toSelf().conditional(c => c.present(PluginBase)))
    di.bind(Plugin, t =>
      t
        .toSelf()
        .extends(PluginBase)
        .conditional(c => c.missing(Feature)),
    )

    await expect(di.init()).rejects.toThrow(/its condition present\("PluginBase"\) was decided before "Plugin"/)
  })

  // Feature read the provider registered first; the held one, which waited for Feature, then replaced it.
  it('follows the cycle through the config provider', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Feature, t => t.toSelf().conditional(c => c.config('feature.on')))
    di.bindConfigProvider(t => t.toValue({ feature: { on: true } }))
    di.bindConfigProvider(t => t.toValue({ feature: { on: false } }).conditional(c => c.present(Feature)))

    await expect(di.init()).rejects.toThrow(/Cannot decide "Feature": its condition config\("feature\.on"\)/)
  })

  // Rejected on the value of the provider it read, Feature would have passed on the one that replaced it.
  it('fails when the config provider a rejected binding read is replaced afterwards', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Feature, t => t.toSelf().conditional(c => c.config('feature.on')))
    di.bindConfigProvider(t => t.toValue({ feature: { on: false } }))
    di.bindConfigProvider(t => t.toValue({ feature: { on: true } }).conditional(c => c.missing(Feature)))

    await expect(di.init()).rejects.toThrow(/Cannot decide "Feature": its condition config\("feature\.on"\)/)
  })

  // Feature found the key present before the cycle closed, and it still is: nothing it decided on changed.
  it('keeps a binding whose presence check was already met when the cycle was broken', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(BuiltInPlugin, t => t.toSelf().names(kPlugins))
    di.bind(Feature, t => t.toSelf().conditional(c => c.present(kPlugins)))
    di.bind(Plugin, t =>
      t
        .toSelf()
        .names(kPlugins)
        .conditional(c => c.present(Feature)),
    )
    await di.init()

    expect([di.has(Feature), di.has(Plugin)]).toEqual([true, true])
  })

  it('settles two bindings that each yield to the other: the first registers, the other sees it', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Rock, t => t.toSelf().conditional(c => c.missing(Paper)))
    di.bind(Paper, t => t.toSelf().conditional(c => c.missing(Rock)))
    await di.init()

    expect([di.has(Rock), di.has(Paper)]).toEqual([true, false])
  })

  // The first default is rejected by its own switch, not by the key the second answers to, so the second registering
  // afterwards leaves its decision standing.
  it('settles two defaults of one key when the first is switched off', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(SwitchedOffPlugin, t =>
      t
        .toSelf()
        .extends(PluginBase)
        .conditional(c => c.missing(PluginBase))
        .conditional(c => c.when(() => false)),
    )
    di.bind(Plugin, t =>
      t
        .toSelf()
        .extends(PluginBase)
        .conditional(c => c.missing(PluginBase)),
    )
    await di.init()

    expect(di.getMany(PluginBase)).toEqual([expect.any(Plugin)])
  })

  it('settles two bindings that each need the other by leaving both out', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Rock, t => t.toSelf().conditional(c => c.present(Paper)))
    di.bind(Paper, t => t.toSelf().conditional(c => c.present(Rock)))
    await di.init()

    expect([di.has(Rock), di.has(Paper)]).toEqual([false, false])
  })
})

// A conditional binding made by hand replaces a binding of its key only when its conditions pass, whether that binding
// is registered or still held back beside it. Only a binding without conditions discards the held ones outright.
describe('conditional bindings of one key made by hand', function () {
  const kMode = token<string>(Symbol('held-beside-mode'))

  const bindMode = (di: CaffeineIoC, value: string, passes: boolean) =>
    di.bind(kMode, t => t.toValue(value).conditional(c => c.when(() => passes)))

  it('keep the first when the second fails', async function () {
    const di = new CaffeineIoC({ decorators: false })
    bindMode(di, 'first', true)
    bindMode(di, 'second', false)
    await di.init()

    expect(di.get(kMode)).toBe('first')
  })

  it('take the second when the first fails', async function () {
    const di = new CaffeineIoC({ decorators: false })
    bindMode(di, 'first', false)
    bindMode(di, 'second', true)
    await di.init()

    expect(di.get(kMode)).toBe('second')
  })

  it('take the later of two that pass, as a second bind() replaces the first', async function () {
    const di = new CaffeineIoC({ decorators: false })
    bindMode(di, 'first', true)
    bindMode(di, 'second', true)
    await di.init()

    expect(di.get(kMode)).toBe('second')
  })

  it('let a default bound after a competitor yield to it', async function () {
    const di = new CaffeineIoC({ decorators: false })
    bindMode(di, 'competitor', true)
    di.bind(kMode, t => t.toValue('default').conditional(c => c.missing(kMode)))
    await di.init()

    expect(di.get(kMode)).toBe('competitor')
  })

  it('let a default bound before a competitor yield to it', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(kMode, t => t.toValue('default').conditional(c => c.missing(kMode)))
    bindMode(di, 'competitor', true)
    await di.init()

    expect(di.get(kMode)).toBe('competitor')
  })

  it('are all discarded by a binding of the key without conditions', async function () {
    const di = new CaffeineIoC({ decorators: false })
    bindMode(di, 'first', true)
    bindMode(di, 'second', true)
    di.bind(kMode, t => t.toValue('plain'))
    await di.init()

    expect(di.get(kMode)).toBe('plain')
  })

  it('are all dropped by rebind()', async function () {
    const di = new CaffeineIoC({ decorators: false })
    bindMode(di, 'first', true)
    bindMode(di, 'second', true)
    di.rebind(kMode, t => t.toValue('rebound'))
    await di.init()

    expect(di.get(kMode)).toBe('rebound')
  })

  it('are carried through snapshot() and restore(), and decided the same way', async function () {
    const source = new CaffeineIoC({ decorators: false })
    bindMode(source, 'first', true)
    bindMode(source, 'second', false)

    const di = new CaffeineIoC({ decorators: false })
    di.restore(source.snapshot())
    await di.init()

    expect(di.get(kMode)).toBe('first')
  })
})

// A binding held back while the container decides the held bindings could be ordered against none of those already
// decided. Rather than decide it out of order, or drop it without a word, the container refuses it.
describe('a binding with conditions made while the conditions are decided', function () {
  const kTrigger = token<string>(Symbol('late-trigger'))
  const kLate = token<string>(Symbol('late-held'))

  const bindLate = (di: CaffeineIoC) => di.bind(kLate, t => t.toValue('late').conditional(c => c.when(() => true)))

  it('is refused when a condition makes it', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(kTrigger, t =>
      t.toValue('trigger').conditional(c =>
        c.when(() => {
          bindLate(di)
          return true
        }),
      ),
    )

    const init = di.init()

    await expect(init).rejects.toThrow(ErrInvalidContainerState)
    await expect(init).rejects.toThrow(/Cannot decide the conditions of "Symbol\(late-held\)": bound while/)
  })

  it('is refused when a hook makes it', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.hooks.on('onBindingRegistered', ({ key }) => {
      if (key === kTrigger) {
        bindLate(di)
      }
    })
    di.bind(kTrigger, t => t.toValue('trigger').conditional(c => c.when(() => true)))

    await expect(di.init()).rejects.toThrow(ErrInvalidContainerState)
  })

  it('is refused when the config provider makes it', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bindConfigProvider(t =>
      t.toFactory(() => {
        bindLate(di)
        return { on: true }
      }),
    )
    di.bind(kTrigger, t => t.toValue('trigger').conditional(c => c.config('on')))

    await expect(di.init()).rejects.toThrow(ErrInvalidContainerState)
  })

  it('is not what a binding without conditions is: that one registers, as it would from anywhere', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(kTrigger, t =>
      t.toValue('trigger').conditional(c =>
        c.when(() => {
          di.bind(kLate, b => b.toValue('late'))
          return true
        }),
      ),
    )
    await di.init()

    expect(di.get(kLate)).toBe('late')
  })
})

// What init() called again after a failure sees: the bindings decided before the throw stay decided, so none is
// decided twice.
describe('a compile that throws half-way', function () {
  class Decided {}
  class Flaky {}

  it('decides only what was left when init() runs again', async function () {
    const decided = vi.fn(() => true)
    let fail = true
    const di = new CaffeineIoC({ decorators: false })
    di.bind(Decided, t => t.toSelf().conditional(c => c.when(decided)))
    di.bind(Flaky, t =>
      t.toSelf().conditional(c =>
        c.when(() => {
          if (fail) {
            throw new Error('flaky condition')
          }
          return true
        }),
      ),
    )

    await expect(di.init()).rejects.toThrow('flaky condition')

    fail = false
    await di.init()

    expect(decided).toHaveBeenCalledTimes(1)
    expect([di.has(Decided), di.has(Flaky)]).toEqual([true, true])
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

  it('rejects a helper handed something it cannot check', function () {
    expect(() => $cond.present(null as never)).toThrow(ErrMissingInjectionKey)
    expect(() => $cond.config(42 as never)).toThrow(ErrInvalidBinding)
    expect(() => $cond.when('true' as never)).toThrow(ErrInvalidBinding)
  })

  // Whatever a callback throws that is not the helpers' own error is reported with what it threw, Error or not.
  it('reports what a callback threw', function () {
    class Failure {
      toString(): string {
        return 'not an error'
      }
    }

    class Throws {}
    const di = new CaffeineIoC({ decorators: false })

    expect(() =>
      di.bind(Throws, t =>
        t.toSelf().conditional((() => {
          throw new Failure()
        }) as never),
      ),
    ).toThrow(/the callback threw "not an error"/)
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

  // The reader is the application's own. Called twice for one binding it would repeat whatever it does, and a reader
  // answering differently the second time would contradict the decision to hold the binding back.
  describe('called once for every binding', function () {
    const kReadProvided = token<string>(Symbol('read-once-provided'))

    @Injectable()
    class ReadOnceDecorated {}

    @Injectable()
    @Profile('read-once')
    class ReadOnceHeldDecorated {}

    @Configuration()
    class ReadOnceConfig {
      @Provides(kReadProvided)
      value(): string {
        return 'provided'
      }
    }

    class Plain {}
    class HeldPassing {}
    class HeldFailing {}

    it('whether it is bound by hand, registers at once, waits for its conditions or fails them', async function () {
      const read = vi.fn((_key: unknown) => ({}))
      const di = new CaffeineIoC({ metadataReader: read, profiles: ['read-once'] })
      di.bind(Plain, t => t.toSelf())
      di.bind(HeldPassing, t => t.toSelf().conditional(c => c.when(() => true)))
      di.bind(HeldFailing, t => t.toSelf().conditional(c => c.when(() => false)))
      await di.init()

      const calls = (key: unknown) => read.mock.calls.filter(([k]) => k === key).length
      const keys = [
        Plain,
        HeldPassing,
        HeldFailing,
        ReadOnceDecorated,
        ReadOnceHeldDecorated,
        ReadOnceConfig,
        kReadProvided,
      ]

      expect(keys.map(calls)).toEqual(keys.map(() => 1))
      expect([di.has(HeldPassing), di.has(HeldFailing), di.has(ReadOnceHeldDecorated)]).toEqual([true, false, true])
    })

    it('and what it returned still applies to a binding that waited for its conditions', async function () {
      class Transient {}
      const di = new CaffeineIoC({
        decorators: false,
        metadataReader: key => (key === Transient ? { scopeID: Scopes.TRANSIENT } : {}),
      })
      di.bind(Transient, t => t.toSelf().conditional(c => c.when(() => true)))
      await di.init()

      expect(di.get(Transient)).not.toBe(di.get(Transient))
    })
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

  it('leaves out a held internal binding, as it leaves out a registered one', function () {
    const kInternal = token<string>(Symbol('snapshot-held-internal'))
    const source = new CaffeineIoC({ decorators: false })
    source.bind(kInternal, t =>
      t
        .toValue('x')
        .internal()
        .conditional(c => c.when(() => true)),
    )

    expect(
      source
        .snapshot()
        .entries()
        .map(([key]) => key),
    ).not.toContain(kInternal)
  })

  it('takes the place of a binding this container holds for the key, even one the snapshot had decided', async function () {
    const kDecided = token<string>(Symbol('snapshot-decided-over-held'))
    const source = new CaffeineIoC({ decorators: false })
    source.bind(kDecided, t => t.toValue('snapshot'))
    await source.init()

    const di = new CaffeineIoC({ decorators: false })
    di.bind(kDecided, t => t.toValue('container').conditional(c => c.when(() => true)))
    di.restore(source.snapshot())
    await di.init()

    expect(di.get(kDecided)).toBe('snapshot')
  })

  // A @Provides binding goes with the class it was declared in, whether that class is held back or registered.
  describe('a @Provides binding', function () {
    const kOrphan = token<string>(Symbol('snapshot-orphan-provides'))
    const kOwn = token<string>(Symbol('snapshot-own-provides'))

    @Configuration()
    @Profile('snapshot-orphan')
    class OrphanConfig {
      @Provides(kOrphan)
      value(): string {
        return 'provided'
      }
    }

    @Configuration()
    class RegisteredConfig {
      @Conditional(c => c.profile('snapshot-own'))
      @Provides(kOwn)
      value(): string {
        return 'provided'
      }
    }
    void RegisteredConfig

    // What TestContainer.skip() of the class does: the class goes, and what it provides goes with it.
    it('is left out with its held class', async function () {
      const notRegistered = vi.fn()
      const source = new CaffeineIoC({ profiles: ['snapshot-orphan'] })
      const di = new CaffeineIoC({ decorators: false })
      di.hooks.on('onBindingNotRegistered', ({ key }) => notRegistered(key))
      di.restore(source.snapshot().exclude(OrphanConfig))
      await di.init()

      expect(di.has(kOrphan)).toBe(false)
      expect(notRegistered).toHaveBeenCalledWith(kOrphan)
    })

    it('is decided on its own conditions when its class was registered', async function () {
      const passing = new CaffeineIoC({ decorators: false })
      passing.restore(new CaffeineIoC({ profiles: ['snapshot-own'] }).snapshot())
      await passing.init()

      const failing = new CaffeineIoC({ decorators: false })
      failing.restore(new CaffeineIoC().snapshot())
      await failing.init()

      expect(passing.get(kOwn)).toBe('provided')
      expect(failing.has(kOwn)).toBe(false)
    })
  })

  it('cannot restore once the container has been compiled', async function () {
    const di = new CaffeineIoC({ decorators: false })
    await di.compile()

    expect(() => di.restore(new CaffeineIoC({ decorators: false }).snapshot())).toThrow(ErrInvalidContainerState)
  })
})
