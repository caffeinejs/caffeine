import { describe, it, expect } from 'vitest'
import { CaffeineIoC } from '../container.js'
import { Injectable } from '../decorators/injectable.js'
import { Fallback } from '../decorators/fallback.js'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { Configuration } from '../decorators/configuration.js'
import { Profile } from '../decorators/profile.js'
import { Provides } from '../decorators/provides.js'

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

    expect(di.has(DefaultService))
      .toBe(true)
    expect(di.get(DefaultService)
      .value())
      .toBe('default')
  })

  it('should be skipped when a non-fallback binding is manually registered for the same key', async function () {
    const di = new CaffeineIoC()

    class OverrideService {
      value() {
        return 'override'
      }
    }

    di.bind(DefaultService)
      .toClass(OverrideService)
    await di.init()

    expect((di.get(DefaultService) as OverrideService).value())
      .toBe('override')
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
  const kFallbackOnly = Symbol('fb-fallback-only')
  const kShared = Symbol('fb-shared')
  const kConcrete = Symbol('fb-concrete')

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

    expect(di.get(kFallbackOnly))
      .toBe('lib-fallback-only')
  })

  it('should skip a fallback @Provides bean when a non-fallback binding exists for the same key', async function () {
    const di = new CaffeineIoC()
    await di.init()

    expect(di.get(kShared))
      .toBe('consumer-shared')
  })

  it('should always register non-fallback @Provides beans from the same @Configuration class', async function () {
    const di = new CaffeineIoC()
    await di.init()

    expect(di.get(kConcrete))
      .toBe('lib-concrete')
  })
})

// ----- .fallback() fluent API ------------------------------------------------

describe('.fallback() on BinderOptions', function () {
  it('should register the binding when no other binding exists for the key', async function () {
    const kFlu = Symbol('flu-only')

    class FluLib {
      tag() {
        return 'flu-lib'
      }
    }

    const di = new CaffeineIoC({ decorators: false })

    di.bind(kFlu)
      .toClass(FluLib)
      .fallback()
    await di.init()

    expect(di.has(kFlu))
      .toBe(true)
    expect((di.get(kFlu) as FluLib).tag())
      .toBe('flu-lib')
  })

  it('should be overridden when a subsequent non-fallback binding is registered for the same key', async function () {
    const kFlu2 = Symbol('flu-overridden')

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

    di.bind(kFlu2)
      .toClass(FluLib)
      .fallback()
    di.bind(kFlu2)
      .toClass(FluConsumer)
    await di.init()

    expect((di.get(kFlu2) as FluConsumer).tag())
      .toBe('flu-consumer')
  })
})

// ----- @Fallback() ordering guarantee ----------------------------------------

describe('@Fallback() ordering guarantee via @Provides', function () {
  const kFirst = Symbol('order-first')
  const kSecond = Symbol('order-second')

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

    expect(di.get(kFirst))
      .toBe('second-non-fallback-wins')
    expect(di.get(kSecond))
      .toBe('second-non-fallback')
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
    di.bind(FbCondSkip).toValue('override' as unknown as FbCondSkip)
    await di.init()

    expect(di.get(FbCondSkip)).toBe('override')
  })
})
