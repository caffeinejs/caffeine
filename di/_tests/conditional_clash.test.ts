import { describe, expect, it } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Conditional } from '../decorators/conditional.js'
import { Configuration } from '../decorators/configuration.js'
import { Injectable } from '../decorators/injectable.js'
import { Profile } from '../decorators/profile.js'
import { Provides } from '../decorators/provides.js'
import { ErrRepeatedInjectableConfiguration } from '../errors.js'
import { token } from '../key.js'
import { mod } from '../module.js'

// A binding decided at compile() never silently replaces another binding of its key. Whether an explicit binding
// survived used to depend on whether a class elsewhere carried a condition, and on which of the two was decided last.
// Each fixture sits behind its own profile, so only the test that activates it sees it.
describe('Conditional clashes', function () {
  describe('throw ErrRepeatedInjectableConfiguration', function () {
    const kHand = token<string>(Symbol('clash-hand'))
    const kModule = token<string>(Symbol('clash-module'))
    const kBeside = token<string>(Symbol('clash-beside'))
    const kBoth = token<string>(Symbol('clash-both'))

    @Configuration()
    @Conditional(c => c.when(() => true))
    @Profile('clash-hand')
    class ProvidesOverHand {
      @Provides(kHand)
      value(): string {
        return 'provided'
      }
    }

    @Configuration()
    @Conditional(c => c.when(() => true))
    @Profile('clash-module')
    class ProvidesOverModule {
      @Provides(kModule)
      value(): string {
        return 'provided'
      }
    }

    @Configuration()
    @Conditional(c => c.when(() => true))
    @Profile('clash-beside')
    class ConditionalBeside {
      @Provides(kBeside)
      value(): string {
        return 'conditional'
      }
    }

    @Configuration()
    @Profile('clash-beside')
    class PlainBeside {
      @Provides(kBeside)
      value(): string {
        return 'plain'
      }
    }

    @Configuration()
    @Conditional(c => c.when(() => true))
    @Profile('clash-both')
    class FirstPassing {
      @Provides(kBoth)
      value(): string {
        return 'first'
      }
    }

    @Configuration()
    @Conditional(c => c.when(() => true))
    @Profile('clash-both')
    class SecondPassing {
      @Provides(kBoth)
      value(): string {
        return 'second'
      }
    }

    @Conditional(c => c.when(() => true))
    @Injectable()
    @Profile('clash-self')
    class ConditionalService {}

    void [ProvidesOverHand, ProvidesOverModule, ConditionalBeside, PlainBeside, FirstPassing, SecondPassing]

    it('should refuse a conditional class @Provides over a binding made by hand', async function () {
      const di = new CaffeineIoC({ profiles: ['clash-hand'] })
      di.bind(kHand, t => t.toValue('hand'))

      await expect(di.init()).rejects.toThrow(ErrRepeatedInjectableConfiguration)
    })

    it('should refuse it over a key a module binds', async function () {
      const di = new CaffeineIoC({
        profiles: ['clash-module'],
        modules: [mod('clash-module', container => container.bind(kModule, t => t.toValue('module')))],
      })

      await expect(di.init()).rejects.toThrow(ErrRepeatedInjectableConfiguration)
    })

    // bind() of a decorated class starts from its decorators, conditions included, so both pass together. rebind()
    // is what replaces a decorated binding.
    it('should refuse bind() of a conditional decorated class, pointing to rebind()', async function () {
      const di = new CaffeineIoC({ profiles: ['clash-self'] })
      di.bind(ConditionalService, t => t.toSelf())

      await expect(di.init()).rejects.toThrow(/rebind\(\)/)
    })

    it('should refuse it whichever of the two is decided first', async function () {
      const di = new CaffeineIoC({ decorators: false, profiles: ['clash-self'] })
      di.bind(ConditionalService, t => t.toSelf())
      // Wired after the binding made by hand, the decorated binding is decided after it.
      di.autoWire()

      await expect(di.init()).rejects.toThrow(ErrRepeatedInjectableConfiguration)
    })

    it('should refuse a passing conditional @Provides beside an unconditional one of its key', async function () {
      const di = new CaffeineIoC({ profiles: ['clash-beside'] })

      await expect(di.init()).rejects.toThrow(ErrRepeatedInjectableConfiguration)
    })

    it('should refuse two passing conditional @Provides of one key', async function () {
      const di = new CaffeineIoC({ profiles: ['clash-both'] })

      await expect(di.init()).rejects.toThrow(ErrRepeatedInjectableConfiguration)
    })
  })

  describe('do not throw', function () {
    const kExclusive = token<string>(Symbol('clash-exclusive'))

    @Configuration()
    @Conditional(c => c.when(() => true))
    @Profile('clash-exclusive')
    class OnRegion {
      @Provides(kExclusive)
      value(): string {
        return 'on'
      }
    }

    @Configuration()
    @Conditional(c => c.when(() => false))
    @Profile('clash-exclusive')
    class OffRegion {
      @Provides(kExclusive)
      value(): string {
        return 'off'
      }
    }

    @Conditional(c => c.when(() => true))
    @Injectable()
    @Profile('clash-rebind')
    class Rebound {
      readonly origin: string = 'decorated'
    }

    @Injectable()
    @Profile('clash-over-decorated')
    class Decorated {
      readonly origin: string = 'decorated'
    }

    @Conditional(c => c.when(() => true))
    @Injectable()
    @Profile('clash-retry')
    class DecidedFirst {}

    @Conditional(c =>
      c.when(() => {
        throw new Error('condition failed to decide')
      }),
    )
    @Injectable()
    @Profile('clash-retry')
    class ThrowsDeciding {}

    @Conditional(c => c.when(() => true))
    @Injectable()
    @Profile('clash-restore')
    class Restored {}

    void [OnRegion, OffRegion, DecidedFirst, ThrowsDeciding]

    it('should register the one binding whose condition passes when the conditions are exclusive', async function () {
      const di = new CaffeineIoC({ profiles: ['clash-exclusive'] })
      await di.init()

      expect(di.get(kExclusive)).toBe('on')
    })

    it('should let rebind() replace a decorated conditional binding', async function () {
      const di = new CaffeineIoC({ profiles: ['clash-rebind'] })
      di.rebind(Rebound, t => t.toValue({ origin: 'rebound' }))
      await di.init()

      expect(di.get(Rebound).origin).toBe('rebound')
    })

    it('should let a conditional binding made by hand replace an earlier one made by hand', async function () {
      const kReplaced = token<string>(Symbol('clash-replaced'))

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kReplaced, t => t.toValue('first'))
      di.bind(kReplaced, t => t.toValue('second').conditional(c => c.when(() => true)))
      await di.init()

      expect(di.get(kReplaced)).toBe('second')
    })

    // The rule bind() has always followed: a binding made by hand replaces a decorated one registered when the
    // container was built.
    it('should let a conditional binding made by hand replace a decorated binding registered at construction', async function () {
      const di = new CaffeineIoC({ profiles: ['clash-over-decorated'] })
      di.bind(Decorated, t => t.toValue({ origin: 'hand' }).conditional(c => c.when(() => true)))
      await di.init()

      expect(di.get(Decorated).origin).toBe('hand')
    })

    // The first attempt registered DecidedFirst before ThrowsDeciding threw. A second init() meets that registration
    // again: it is the entry's own, so the original error comes back instead of a clash.
    it('should report the original error when init() is retried after a condition threw', async function () {
      const di = new CaffeineIoC({ profiles: ['clash-retry'] })

      await expect(di.init()).rejects.toThrow('condition failed to decide')
      await expect(di.init()).rejects.toThrow('condition failed to decide')
    })

    // The snapshot carries the decided copy of Restored, with its conditions. It takes the place of the decorated
    // binding this container found for the same class, rather than meeting it at compile().
    it('should restore a compiled snapshot into a container that reads decorators', async function () {
      const source = new CaffeineIoC({ profiles: ['clash-restore'] })
      await source.init()

      const di = new CaffeineIoC({ profiles: ['clash-restore'] })
      di.restore(source.snapshot())
      await di.init()

      expect(di.get(Restored)).toBeInstanceOf(Restored)
    })
  })
})
