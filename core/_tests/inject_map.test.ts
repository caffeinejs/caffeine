import { describe, it, expect } from 'vitest'
import { Injectable } from '../decorators/injectable.js'
import { Named } from '../decorators/named.js'
import { CaffeineIoC } from '../container.js'
import { $i } from '../injection.js'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { Lazy } from '../decorators/lazy.js'

describe('Inject Into Map', function () {
  const kMap = Symbol('map')

  interface Greeter {
    greet(): string
  }

  @Injectable(kMap)
  @Named('hi')
  class Hi implements Greeter {
    greet(): string {
      return 'Hi'
    }
  }

  @Injectable(kMap)
  @Named('bye')
  @Lazy()
  class Bye implements Greeter {
    greet(): string {
      return 'Bye'
    }
  }

  @Injectable(kMap)
  @Named('tschuss')
  @ConditionalOn(() => false)
  class Tschuss implements Greeter {
    greet(): string {
      return 'Tschuss'
    }
  }

  @Injectable([$i.mapped(kMap)])
  class Welcome {
    constructor(readonly greeters: Map<string, Greeter>) {}
  }

  describe('optional injection', function () {
    it('should inject the map when bindings are registered', async function () {
      class OptConsumer {
        constructor(readonly greeters: Map<string, Greeter> | undefined) {}
      }

      const di = new CaffeineIoC()
      await di.init()

      const consumer = di.build(OptConsumer, [$i.optional($i.mapped(kMap))])
      expect(consumer.greeters).toBeInstanceOf(Map)
      expect(consumer.greeters!.get('hi')).toBeInstanceOf(Hi)
      expect(consumer.greeters!.get('bye')).toBeInstanceOf(Bye)
    })

    it('should inject undefined when no bindings are registered for the key', async function () {
      const kAbsent = Symbol('absent-greeters')

      class OptConsumer {
        constructor(readonly data: Map<string, unknown> | undefined) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      await di.init()

      const consumer = di.build(OptConsumer, [$i.optional($i.mapped(kAbsent))])
      expect(consumer.data).toBeUndefined()
    })
  })

  describe('when injecting into a map', function () {
    it('should inject the correct greeter', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const welcome = di.get(Welcome)

      expect(welcome.greeters.get('hi'))
        .toBeInstanceOf(Hi)
      expect(welcome.greeters.get('bye'))
        .toBeInstanceOf(Bye)
      expect(welcome.greeters.get('tschuss'))
        .toBeUndefined()
    })
  })
})
