import { describe, it, expect, beforeEach, vi } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Conditional } from '../decorators/conditional.js'
import { Configuration } from '../decorators/configuration.js'
import { Extends } from '../decorators/extends.js'
import { Injectable } from '../decorators/injectable.js'
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

// A compile that throws half-way keeps held only what it had not decided yet. init() called again then decides no
// binding twice, and reports what failed rather than a clash with a binding it had registered itself.
describe('init() called again after a condition threw', function () {
  const state = { fail: true }

  @Injectable()
  @Profile('clash-retry')
  class RetryDecided {}

  @Injectable()
  @Profile('clash-retry')
  @Conditional(c =>
    c.when(() => {
      if (state.fail) {
        throw new Error('flaky condition')
      }
      return true
    }),
  )
  class RetryFlaky {}

  beforeEach(function () {
    state.fail = true
  })

  it('decides what was left, and registers nothing twice', async function () {
    const registered = vi.fn()
    const di = new CaffeineIoC({ profiles: ['clash-retry'] })
    di.hooks.on('onBindingRegistered', ({ key }) => registered(key))

    await expect(di.init()).rejects.toThrow('flaky condition')

    state.fail = false
    await di.init()

    expect(di.has(RetryFlaky)).toBe(true)
    expect(registered.mock.calls.filter(([key]) => key === RetryDecided)).toHaveLength(1)
  })

  it('reports what failed again while it still fails', async function () {
    const di = new CaffeineIoC({ profiles: ['clash-retry'] })

    await expect(di.init()).rejects.toThrow('flaky condition')
    await expect(di.init()).rejects.toThrow('flaky condition')
  })

  it('still refuses a binding made by hand over a key a decorated binding took before the throw', async function () {
    const di = new CaffeineIoC({ profiles: ['clash-retry'] })
    di.bind(RetryDecided, t => t.toSelf().conditional(c => c.when(() => true)))

    await expect(di.init()).rejects.toThrow('flaky condition')

    state.fail = false
    await expect(di.init()).rejects.toThrow(ErrRepeatedInjectableConfiguration)
  })

  it('lets a binding rebind() put in place of the decorated one stand', async function () {
    const di = new CaffeineIoC({ profiles: ['clash-retry'] })

    await expect(di.init()).rejects.toThrow('flaky condition')

    di.rebind(RetryDecided, t => t.toSelf().conditional(c => c.when(() => true)))
    state.fail = false
    await di.init()

    expect(di.has(RetryDecided)).toBe(true)
  })
})

// A container that reads decorators holds its own copy of every conditional class. Restoring a snapshot that had
// decided one puts the snapshot's in its place, rather than deciding the class a second time over it.
describe('a compiled snapshot restored into a container that reads decorators', function () {
  abstract class RestoredStore {
    abstract kind(): string
  }

  @Injectable()
  @Extends()
  @Profile('clash-restore')
  class RestoredRedisStore extends RestoredStore {
    kind(): string {
      return 'redis'
    }
  }
  void RestoredRedisStore

  @Injectable()
  @Extends()
  @Conditional(c => c.missing(RestoredStore))
  class RestoredMemoryStore extends RestoredStore {
    kind(): string {
      return 'memory'
    }
  }
  void RestoredMemoryStore

  it('registers what the snapshot decided, once, and keeps out the default it beat', async function () {
    const source = new CaffeineIoC({ profiles: ['clash-restore'] })
    await source.init()

    const di = new CaffeineIoC()
    di.restore(source.snapshot())
    await di.init()

    expect(di.getMany(RestoredStore).map(s => s.kind())).toEqual(['redis'])
  })
})
