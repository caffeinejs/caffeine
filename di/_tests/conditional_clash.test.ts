import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Conditional } from '../decorators/conditional.js'
import { Configuration } from '../decorators/configuration.js'
import { Profile } from '../decorators/profile.js'
import { Provides } from '../decorators/provides.js'
import { ErrRepeatedInjectableConfiguration } from '../errors.js'
import { token } from '../key.js'

// Decorated classes are read by every container in a file, so a fixture whose release throws is scoped by a profile only
// its own test activates.

// #47: a provided binding is tied to the class it was declared in, not to every held class providing the same key.
describe('a @Provides binding of a held @Configuration', function () {
  const kValue = token<string>(Symbol('clash-47-value'))
  const kPassing = token<string>(Symbol('clash-47-passing'))

  @Configuration()
  @Conditional(c => c.when(() => false))
  class Optional {
    @Provides(kValue)
    value(): string {
      return 'optional'
    }
  }

  @Configuration()
  class Regular {
    @Provides(kValue)
    value(): string {
      return 'regular'
    }
  }

  @Configuration()
  @Profile('clash-47')
  class PassingOptional {
    @Provides(kPassing)
    value(): string {
      return 'optional'
    }
  }

  @Configuration()
  class PassingRegular {
    @Provides(kPassing)
    value(): string {
      return 'regular'
    }
  }
  void PassingOptional
  void PassingRegular

  it('does not take the same key provided by another class down with its own class', async function () {
    const di = new CaffeineIoC()
    await di.init()

    expect(di.has(Optional)).toBe(false)
    expect(di.has(Regular)).toBe(true)
    expect(di.get(kValue)).toBe('regular')
  })

  it('refuses the key when its class passes too, as two unconditional classes providing it are refused', async function () {
    const di = new CaffeineIoC({ profiles: ['clash-47'] })

    await expect(di.init()).rejects.toThrow(ErrRepeatedInjectableConfiguration)
  })
})

// #48: a decorated binding decided at compile() never replaces one registered under its key, whichever made it.
describe('a decorated binding decided at compile() over a registered key', function () {
  const kHand = token<string>(Symbol('clash-48-hand'))
  const kHeldByHand = token<string>(Symbol('clash-48-held-by-hand'))
  const kProfiled = token<string>(Symbol('clash-48-profiled'))

  @Configuration()
  @Conditional(c => c.when(() => true))
  class Conditional48 {
    @Provides(kHand)
    value(): string {
      return 'provided'
    }

    @Provides(kHeldByHand)
    held(): string {
      return 'provided'
    }
  }
  void Conditional48

  @Configuration()
  @Profile('clash-48-profiled')
  class Profiled48 {
    @Provides(kProfiled)
    value(): string {
      return 'provided'
    }
  }
  void Profiled48

  it('refuses to replace a binding made by hand', async function () {
    const di = new CaffeineIoC()
    di.bind(kHand, t => t.toValue('hand'))

    await expect(di.init()).rejects.toThrow(ErrRepeatedInjectableConfiguration)
  })

  it('names the ways out', async function () {
    const di = new CaffeineIoC()
    di.bind(kHand, t => t.toValue('hand'))

    await expect(di.init()).rejects.toThrow(/rebind\(key, \.\.\.\)[\s\S]*c => c\.missing\(key\)/)
  })

  it('leaves the binding made by hand in place once rebind() dropped the decorated one', async function () {
    const di = new CaffeineIoC()
    di.rebind(kHand, t => t.toValue('hand'))
    await di.init()

    expect(di.get(kHand)).toBe('hand')
  })

  // The same clash seen from the other side: decided after the decorated one, the binding made by hand throws too, so
  // the outcome does not depend on which of the two is decided first.
  it('refuses a held binding made by hand once a decorated one took its key', async function () {
    const di = new CaffeineIoC()
    di.bind(kHeldByHand, t => t.toValue('hand').conditional(c => c.when(() => true)))

    await expect(di.init()).rejects.toThrow(ErrRepeatedInjectableConfiguration)
  })

  // A profile is a condition: a profiled @Provides activated late is decided at compile() like any conditional one.
  it('refuses to replace a binding made by hand with a @Provides of a profile activated later', async function () {
    const di = new CaffeineIoC()
    di.bind(kProfiled, t => t.toValue('hand'))
    di.addProfiles('clash-48-profiled')

    await expect(di.init()).rejects.toThrow(ErrRepeatedInjectableConfiguration)
  })
})
