import { describe, expect, it } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Injectable } from '../decorators/injectable.js'
import { Order } from '../decorators/order.js'
import { $i } from '../injection.js'
import { token } from '../key.js'
import { mod } from '../module.js'

describe('$i.ordered() injection', function () {
  describe('given multiple bindings with @Order — resolves in ascending order', function () {
    const kHandler = token<Handler>(Symbol('handler-ordered-asc'))

    interface Handler {
      name(): string
    }

    @Order(2)
    @Injectable(kHandler)
    class HandlerB implements Handler {
      name() {
        return 'B'
      }
    }

    @Order(1)
    @Injectable(kHandler)
    class HandlerA implements Handler {
      name() {
        return 'A'
      }
    }

    @Order(3)
    @Injectable(kHandler)
    class HandlerC implements Handler {
      name() {
        return 'C'
      }
    }

    @Injectable([$i.ordered(kHandler)])
    class Pipeline {
      constructor(readonly handlers: Handler[]) {}
    }

    it('injects handlers sorted by order value ascending', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const pipeline = di.get(Pipeline)
      expect(pipeline.handlers.map(h => h.name())).toEqual(['A', 'B', 'C'])
    })
  })

  describe('given bindings with equal order values', function () {
    const kTied = token<Tied>(Symbol('handler-ordered-tied'))

    interface Tied {
      label(): string
    }

    @Order(1)
    @Injectable(kTied)
    class TiedA implements Tied {
      label() {
        return 'A'
      }
    }

    @Order(1)
    @Injectable(kTied)
    class TiedB implements Tied {
      label() {
        return 'B'
      }
    }

    @Injectable([$i.ordered(kTied)])
    class TiedConsumer {
      constructor(readonly items: Tied[]) {}
    }

    it('preserves original registration order among ties (stable sort)', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const consumer = di.get(TiedConsumer)
      expect(consumer.items).toHaveLength(2)
      expect(consumer.items.map(t => t.label())).toEqual(['A', 'B'])
    })
  })

  describe('given a mix of ordered and unordered bindings', function () {
    const kStep = token<Step>(Symbol('handler-ordered-mixed'))

    interface Step {
      label(): string
    }

    @Order(1)
    @Injectable(kStep)
    class StepFirst implements Step {
      label() {
        return 'first'
      }
    }

    @Injectable(kStep)
    class StepUnordered implements Step {
      label() {
        return 'unordered'
      }
    }

    @Order(2)
    @Injectable(kStep)
    class StepSecond implements Step {
      label() {
        return 'second'
      }
    }

    @Injectable([$i.ordered(kStep)])
    class Chain {
      constructor(readonly steps: Step[]) {}
    }

    it('places ordered bindings before unordered ones', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const chain = di.get(Chain)
      expect(chain.steps).toHaveLength(3)
      expect(chain.steps[0].label()).toBe('first')
      expect(chain.steps[1].label()).toBe('second')
      expect(chain.steps[2].label()).toBe('unordered')
    })
  })

  describe('given no bindings registered for the key', function () {
    const kEmpty = token<Record<string, unknown>>(Symbol('handler-ordered-empty'))

    @Injectable([$i.ordered(kEmpty)])
    class Consumer {
      constructor(readonly items: unknown[]) {}
    }

    it('injects an empty array', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const consumer = di.get(Consumer)
      expect(consumer.items).toEqual([])
    })
  })
})

describe('$i.ordered() with .order() binder option', function () {
  it('sorts injected array by .order() value', async function () {
    abstract class Plugin {
      abstract id(): string
    }

    class PluginAlpha extends Plugin {
      id() {
        return 'alpha'
      }
    }

    class PluginBeta extends Plugin {
      id() {
        return 'beta'
      }
    }

    class PluginGamma extends Plugin {
      id() {
        return 'gamma'
      }
    }

    const m = mod('plugins', c => {
      c.bind(PluginBeta, t => t.toClass(PluginBeta).extends(Plugin).order(2))
      c.bind(PluginAlpha, t => t.toClass(PluginAlpha).extends(Plugin).order(1))
      c.bind(PluginGamma, t => t.toClass(PluginGamma).extends(Plugin).order(3))
    })

    const di = new CaffeineIoC({ modules: [m] })
    await di.init()

    const plugins = di.build((items: Plugin[]) => items, [$i.ordered(Plugin)]) as Plugin[]

    expect(plugins.map(p => p.id())).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('places bindings without .order() last', async function () {
    abstract class Svc {
      abstract tag(): string
    }

    class SvcA extends Svc {
      tag() {
        return 'A'
      }
    }

    class SvcB extends Svc {
      tag() {
        return 'B'
      }
    }

    class SvcC extends Svc {
      tag() {
        return 'C'
      }
    }

    const m = mod('svcs', c => {
      c.bind(SvcC, t => t.toClass(SvcC).extends(Svc))
      c.bind(SvcA, t => t.toClass(SvcA).extends(Svc).order(1))
      c.bind(SvcB, t => t.toClass(SvcB).extends(Svc).order(2))
    })

    const di = new CaffeineIoC({ modules: [m] })
    await di.init()

    const svcs = di.build((items: Svc[]) => items, [$i.ordered(Svc)]) as Svc[]

    expect(svcs.map(s => s.tag())).toEqual(['A', 'B', 'C'])
  })
})
