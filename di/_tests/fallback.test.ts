import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { Configuration } from '../decorators/configuration.js'
import { Fallback } from '../decorators/fallback.js'
import { Injectable } from '../decorators/injectable.js'
import { Profile } from '../decorators/profile.js'
import { Provides } from '../decorators/provides.js'
import { token } from '../key.js'
import { mod } from '../module.js'

// ----- @Fallback() on a class -----------------------------------------------

describe('@Fallback() on a class', function () {
  @Fallback()
  @Injectable()
  class DefaultService {
    value() {
      return 'default'
    }
  }

  it('should register when no other binding exists for the key', async function () {
    const di = new CaffeineIoC()
    await di.init()

    expect(di.has(DefaultService)).toBe(true)
    expect(di.get(DefaultService).value()).toBe('default')
  })

  it('should be skipped when a non-fallback binding is manually registered for the same key', async function () {
    const di = new CaffeineIoC()

    class OverrideService {
      value() {
        return 'override'
      }
    }

    di.bind(DefaultService, t => t.toClass(OverrideService))
    await di.init()

    expect((di.get(DefaultService) as OverrideService).value()).toBe('override')
  })
})

// ----- @Fallback() on a @Provides method ------------------------------------
//
// Three symbols are used, each with a distinct role:
//   kFallbackOnly  — only LibConfig provides this (as fallback); no consumer
//   kShared        — LibConfig (fallback) AND ConsumerConfig (non-fallback) both provide this
//   kConcrete      — LibConfig provides this as a regular non-fallback bean
//
// All @Configuration classes are declared at the describe-block level so that
// ProvidedBindings contains a stable set of entries from the very first test,
// preventing mid-run accumulation that could affect unrelated tests.

describe('@Fallback() on a @Provides method', function () {
  const kFallbackOnly = token<string>(Symbol('fb-fallback-only'))
  const kShared = token<string>(Symbol('fb-shared'))
  const kConcrete = token<string>(Symbol('fb-concrete'))

  @Configuration()
  class LibConfig {
    @Fallback()
    @Provides(kFallbackOnly)
    fallbackOnly(): string {
      return 'lib-fallback-only'
    }

    @Fallback()
    @Provides(kShared)
    shared(): string {
      return 'lib-shared'
    }

    @Provides(kConcrete)
    concrete(): string {
      return 'lib-concrete'
    }
  }

  @Configuration()
  class ConsumerConfig {
    @Provides(kShared)
    shared(): string {
      return 'consumer-shared'
    }
  }

  it('should register a fallback @Provides bean when no other binding exists for the key', async function () {
    const di = new CaffeineIoC()
    await di.init()

    expect(di.get(kFallbackOnly)).toBe('lib-fallback-only')
  })

  it('should skip a fallback @Provides bean when a non-fallback binding exists for the same key', async function () {
    const di = new CaffeineIoC()
    await di.init()

    expect(di.get(kShared)).toBe('consumer-shared')
  })

  it('should always register non-fallback @Provides beans from the same @Configuration class', async function () {
    const di = new CaffeineIoC()
    await di.init()

    expect(di.get(kConcrete)).toBe('lib-concrete')
  })
})

// ----- .fallback() fluent API ------------------------------------------------

describe('.fallback() on BindingSpec', function () {
  it('should register the binding when no other binding exists for the key', async function () {
    const kFlu = token<FluLib>(Symbol('flu-only'))

    class FluLib {
      tag() {
        return 'flu-lib'
      }
    }

    const di = new CaffeineIoC({ decorators: false })

    di.bind(kFlu, t => t.toClass(FluLib).fallback())
    await di.init()

    expect(di.has(kFlu)).toBe(true)
    expect((di.get(kFlu) as FluLib).tag()).toBe('flu-lib')
  })

  it('should be skipped when a non-fallback binding was registered for the key first', async function () {
    const kFlu3 = token<FluConsumer>(Symbol('flu-loses-to-earlier'))

    class FluLib {
      tag() {
        return 'flu-lib'
      }
    }

    class FluConsumer {
      tag() {
        return 'flu-consumer'
      }
    }

    const di = new CaffeineIoC({ decorators: false })

    // The order the two binds happen in must not decide the outcome. Services bootstrap concurrently, so it
    // is not something a caller can control.
    di.bind(kFlu3, t => t.toClass(FluConsumer))
    di.bind(kFlu3, t => t.toClass(FluLib).fallback())
    await di.init()

    expect((di.get(kFlu3) as FluConsumer).tag()).toBe('flu-consumer')
  })

  it('should keep the first fallback when a second one is registered for the same key', async function () {
    const kFlu4 = token<FirstLib>(Symbol('flu-two-fallbacks'))

    class FirstLib {
      tag() {
        return 'first'
      }
    }

    class SecondLib {
      tag() {
        return 'second'
      }
    }

    const di = new CaffeineIoC({ decorators: false })

    di.bind(kFlu4, t => t.toClass(FirstLib).fallback())
    di.bind(kFlu4, t => t.toClass(SecondLib).fallback())
    await di.init()

    expect((di.get(kFlu4) as FirstLib).tag()).toBe('first')
  })

  it('should register when the competing binding is dropped by a failing conditional', async function () {
    const kFlu5 = token<FluConsumer>(Symbol('flu-competitor-dropped'))

    class FluLib {
      tag() {
        return 'flu-lib'
      }
    }

    class FluConsumer {
      tag() {
        return 'flu-consumer'
      }
    }

    const di = new CaffeineIoC({ decorators: false })

    // The competitor claims the key at bind time and gives it back when its predicate fails, which is why a
    // fallback is resolved after conditionals rather than when it was declared.
    di.bind(kFlu5, t => t.toClass(FluConsumer).conditional(() => false))
    di.bind(kFlu5, t => t.toClass(FluLib).fallback())
    await di.init()

    expect((di.get(kFlu5) as FluLib).tag()).toBe('flu-lib')
  })

  it('should not register a fallback whose own conditional fails', async function () {
    const kFlu6 = token<FluLib>(Symbol('flu-conditional'))

    class FluLib {
      readonly kind = 'lib'
    }

    const di = new CaffeineIoC({ decorators: false })

    di.bind(kFlu6, t =>
      t
        .toClass(FluLib)
        .fallback()
        .conditional(() => false),
    )
    await di.init()

    expect(di.has(kFlu6)).toBe(false)
  })

  it('should not register a fallback whose profiles do not match', async function () {
    const kFlu7 = token<FluLib>(Symbol('flu-profile'))

    class FluLib {
      readonly kind = 'lib'
    }

    const di = new CaffeineIoC({ decorators: false, profiles: ['prod'] })

    di.bind(kFlu7, t => t.toClass(FluLib).fallback().profiles('test'))
    await di.init()

    expect(di.has(kFlu7)).toBe(false)
  })

  it('should lose to a non-fallback binding registered by a module', async function () {
    const kFlu8 = token<FluConsumer>(Symbol('flu-module'))

    class FluLib {
      tag() {
        return 'flu-lib'
      }
    }

    class FluConsumer {
      tag() {
        return 'flu-consumer'
      }
    }

    const di = new CaffeineIoC({
      decorators: false,
      modules: [
        mod('flu-module', container => {
          container.bind(kFlu8, t => t.toClass(FluConsumer))
        }),
      ],
    })

    di.bind(kFlu8, t => t.toClass(FluLib).fallback())
    await di.init()

    expect((di.get(kFlu8) as FluConsumer).tag()).toBe('flu-consumer')
  })

  it('should be invisible until the container is compiled', async function () {
    const kFlu9 = token<FluLib>(Symbol('flu-visibility'))

    class FluLib {
      readonly kind = 'lib'
    }

    const di = new CaffeineIoC({ decorators: false })

    di.bind(kFlu9, t => t.toClass(FluLib).fallback())

    // Unlike every other binding, a fallback is held back until compile() — whether it registers is not known
    // until the bindings it competes with have settled.
    expect(di.has(kFlu9)).toBe(false)

    await di.init()

    expect(di.has(kFlu9)).toBe(true)
  })

  it('should drop a held-back fallback when the key is rebound', async function () {
    const kFlu10 = token<FluLib>(Symbol('flu-rebind'))

    class FluLib {
      tag() {
        return 'flu-lib'
      }
    }

    class FluRebound {
      tag() {
        return 'flu-rebound'
      }
    }

    const di = new CaffeineIoC({ decorators: false })

    di.bind(kFlu10, t => t.toClass(FluLib).fallback())
    di.rebind(kFlu10, t => t.toClass(FluRebound))
    await di.init()

    expect((di.get(kFlu10) as FluRebound).tag()).toBe('flu-rebound')
  })

  it('should be overridden when a subsequent non-fallback binding is registered for the same key', async function () {
    const kFlu2 = token<FluLib>(Symbol('flu-overridden'))

    class FluLib {
      tag() {
        return 'flu-lib'
      }
    }

    class FluConsumer {
      tag() {
        return 'flu-consumer'
      }
    }

    const di = new CaffeineIoC({ decorators: false })

    di.bind(kFlu2, t => t.toClass(FluLib).fallback())
    di.bind(kFlu2, t => t.toClass(FluConsumer))
    await di.init()

    expect((di.get(kFlu2) as FluConsumer).tag()).toBe('flu-consumer')
  })
})

// ----- @Fallback() ordering guarantee ----------------------------------------

describe('@Fallback() ordering guarantee via @Provides', function () {
  const kFirst = token<string>(Symbol('order-first'))
  const kSecond = token<string>(Symbol('order-second'))

  @Configuration()
  class FirstConfig {
    @Fallback()
    @Provides(kFirst)
    bean(): string {
      return 'first-fallback'
    }

    @Provides(kSecond)
    second(): string {
      return 'second-non-fallback'
    }
  }

  @Configuration()
  class SecondConfig {
    @Provides(kFirst)
    bean(): string {
      return 'second-non-fallback-wins'
    }
  }

  it('should always process non-fallback @Provides beans before fallback @Provides beans', async function () {
    const di = new CaffeineIoC()
    await di.init()

    expect(di.get(kFirst)).toBe('second-non-fallback-wins')
    expect(di.get(kSecond)).toBe('second-non-fallback')
  })
})

// ----- @Fallback() + @ConditionalOn() ----------------------------------------

describe('@Fallback() + @ConditionalOn() — conditional evaluation', function () {
  @Fallback()
  @ConditionalOn(() => true)
  @Injectable()
  @Profile('fb-cond-pass')
  class FbCondPass {}

  @Fallback()
  @ConditionalOn(() => false)
  @Injectable()
  @Profile('fb-cond-fail')
  class FbCondFail {}

  @Fallback()
  @ConditionalOn(() => true)
  @Injectable()
  @Profile('fb-cond-skip')
  class FbCondSkip {}

  it('should register a @Fallback + @ConditionalOn bean when condition passes and no competing binding exists', async function () {
    const di = new CaffeineIoC({ profiles: ['fb-cond-pass'] })
    await di.init()

    expect(di.has(FbCondPass)).toBe(true)
    expect(di.get(FbCondPass)).toBeInstanceOf(FbCondPass)
  })

  it('should not register a @Fallback + @ConditionalOn bean when condition fails', async function () {
    const di = new CaffeineIoC({ profiles: ['fb-cond-fail'] })
    await di.init()

    expect(di.has(FbCondFail)).toBe(false)
  })

  it('should skip a @Fallback + @ConditionalOn bean when a competing binding already exists', async function () {
    const di = new CaffeineIoC({ profiles: ['fb-cond-skip'] })
    di.bind(FbCondSkip, t => t.toValue('override' as unknown as FbCondSkip))
    await di.init()

    expect(di.get(FbCondSkip)).toBe('override')
  })
})
