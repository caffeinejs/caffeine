import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { Injectable } from '../decorators/injectable.js'
import { Lazy } from '../decorators/lazy.js'
import { Named } from '../decorators/named.js'
import { $i } from '../injection.js'
import { token } from '../key.js'

describe('Inject Into Map', function () {
  const kMap = token<Greeter>(Symbol('map'))

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
      const kAbsent = token<Record<string, unknown>>(Symbol('absent-greeters'))

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

      expect(welcome.greeters.get('hi')).toBeInstanceOf(Hi)
      expect(welcome.greeters.get('bye')).toBeInstanceOf(Bye)
      expect(welcome.greeters.get('tschuss')).toBeUndefined()
    })
  })

  describe('when the consumer answers to the key it maps', function () {
    // A registry extending the base it collects is one of that base's bindings. Mapping it into itself would build
    // it while it is being built, so, as with allOf, it receives every binding but its own.
    abstract class Widget {}

    class Button extends Widget {}

    class WidgetRegistry extends Widget {
      constructor(readonly widgets: Map<string, Widget>) {
        super()
      }
    }

    it('should map every other binding and leave the consumer out', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(Button, t => t.toSelf().extends(Widget).names('button'))
      di.bind(WidgetRegistry, t =>
        t
          .toSelf([$i.mapped(Widget)])
          .extends(Widget)
          .names('registry'),
      )
      await di.init()

      const registry = di.get(WidgetRegistry)

      expect([...registry.widgets.keys()]).toEqual(['button'])
      expect(registry.widgets.get('button')).toBeInstanceOf(Button)
    })

    it('should inject an empty map when the consumer is the only binding', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(WidgetRegistry, t =>
        t
          .toSelf([$i.mapped(Widget)])
          .extends(Widget)
          .names('registry'),
      )
      await di.init()

      expect(di.get(WidgetRegistry).widgets.size).toBe(0)
    })
  })
})
