import { describe, it, expect } from 'vitest'
import { CaffeineIoC } from '../container.js'
import { Inject } from '../decorators/inject.js'
import { Injectable } from '../decorators/injectable.js'
import { $i } from '../injection.js'
import { ErrCircularDependency } from '../errors.js'
import { Bar, BarTransient } from './_testdata/circular/Bar.js'
import { Foo, FooTransient } from './_testdata/circular/Foo.js'
import { BarFail } from './_testdata/circular/BarFail.js'
import { FooFail } from './_testdata/circular/FooFail.js'
import { HandlerA, HandlerB, HandlerC } from './_testdata/circular/handler_peers.js'
import { SoleHandlerA } from './_testdata/circular/handler_sole.js'
import { DispatchHandlerA, DispatchHandlerB, Dispatcher } from './_testdata/circular/handler_dispatch.js'

describe('Circular References', function () {
  describe('dependencies with deferred constructor', function () {
    it('should resolve dependencies', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const foo = di.get(Foo)
      const bar = di.get(Bar)
      const foo2 = di.get(Foo)
      const bar2 = di.get(Bar)

      di.get(Foo)
      di.get(Bar)

      expect(foo.test())
        .toEqual('foo-bar')
      expect(bar.test())
        .toEqual('bar-foo')

      expect(foo2.test())
        .toEqual('foo-bar')
      expect(bar2.test())
        .toEqual('bar-foo')

      expect(foo.uuid)
        .toEqual(foo2.uuid)
    })

    it('should resolve dependencies with mixed scopes', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const foo = di.get(FooTransient)
      const bar = di.get(BarTransient)
      const foo2 = di.get(FooTransient)
      const bar2 = di.get(BarTransient)

      expect(foo.test())
        .toEqual('foo-bar')
      expect(bar.test())
        .toEqual('bar-foo')

      expect(foo2.test())
        .toEqual('foo-bar')
      expect(bar2.test())
        .toEqual('bar-foo')

      expect(foo.uuid).not.toEqual(foo2.uuid)
      expect(bar.uuid).not.toEqual(bar2.uuid)
    })
  })

  describe('when a circular dependency does not use the defer injection', function () {
    it('should build inconsistent dependency graph', async () => {
      const di = new CaffeineIoC()
      await di.init()

      const bar = di.get(BarFail)
      const foo = di.get(FooFail)

      expect(bar.foo)
        .toBeInstanceOf(FooFail)
      expect(foo.bar)
        .toBeUndefined()
      expect(() => foo.test())
        .toThrow()
    })
  })

  @Injectable()
  class PropService {
    tag() {
      return 'prop-service'
    }
  }

  @Injectable()
  class PropConsumer {
    @Inject($i.defer(() => PropService))
    svc!: PropService
  }

  describe('deferred key in property injection', function () {
    it('should resolve the property via the deferred binding', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const consumer = di.get(PropConsumer)

      expect(consumer.svc)
        .toBeInstanceOf(PropService)
      expect(consumer.svc.tag())
        .toEqual('prop-service')
    })
  })

  @Injectable()
  class MethodService {
    tag() {
      return 'method-service'
    }
  }

  @Injectable()
  class MethodConsumer {
    svc!: MethodService

    @Inject([$i.defer(() => MethodService)])
    init(svc: MethodService) {
      this.svc = svc
    }
  }

  describe('deferred key in method injection', function () {
    it('should inject via the method using the deferred binding', async function () {
      const di = new CaffeineIoC()
      await di.init()
      const consumer = di.get(MethodConsumer)

      expect(consumer.svc)
        .toBeInstanceOf(MethodService)
      expect(consumer.svc.tag())
        .toEqual('method-service')
    })
  })

  describe('cycle detection at init()', function () {
    it('should throw ErrCircularDependency when two classes have mutual non-optional constructor deps', async function () {
      class CycleA {
        constructor(readonly b: CycleB) {}
      }

      class CycleB {
        constructor(readonly a: CycleA) {}
      }

      const di = new CaffeineIoC({ checks: { circularReferences: true }, decorators: false })
      di.bind(CycleA)
        .toSelf([CycleB])
      di.bind(CycleB)
        .toSelf([CycleA])

      await expect(di.init()).rejects.toThrow(ErrCircularDependency)
    })

    it('should include the full cycle path in the error message', async function () {
      class CycleA {
        constructor(readonly b: CycleB) {}
      }

      class CycleB {
        constructor(readonly a: CycleA) {}
      }

      const di = new CaffeineIoC({ checks: { circularReferences: true }, decorators: false })
      di.bind(CycleA)
        .toSelf([CycleB])
      di.bind(CycleB)
        .toSelf([CycleA])

      let message = ''
      try {
        await di.init()
      } catch (e) {
        message = (e as Error).message
      }

      expect(message)
        .toContain('CycleA')
      expect(message)
        .toContain('CycleB')
      expect(message)
        .toMatch(/→/)
    })

    it('should detect a 3-node constructor cycle', async function () {
      class NodeA {
        constructor(readonly b: NodeB) {}
      }

      class NodeB {
        constructor(readonly c: NodeC) {}
      }

      class NodeC {
        constructor(readonly a: NodeA) {}
      }

      const di = new CaffeineIoC({ checks: { circularReferences: true }, decorators: false })
      di.bind(NodeA)
        .toSelf([NodeB])
      di.bind(NodeB)
        .toSelf([NodeC])
      di.bind(NodeC)
        .toSelf([NodeA])

      await expect(di.init()).rejects.toThrow(ErrCircularDependency)
    })

    it('should not throw when the dep that closes the cycle is optional', async function () {
      class OptA {
        constructor(readonly b: OptB | undefined) {}
      }

      class OptB {
        constructor(readonly a: OptA) {}
      }

      const di = new CaffeineIoC({ checks: { circularReferences: true }, decorators: false })
      di.bind(OptA)
        .toSelf([$i.optional(OptB)])
        .lazy()
      di.bind(OptB)
        .toSelf([OptA])
        .lazy()

      await di.init()
    })

    it('should not throw when the dep that closes the cycle uses $i.defer()', async function () {
      class DeferA {
        constructor(readonly b: DeferB) {}
      }

      class DeferB {
        constructor(readonly a: DeferA) {}
      }

      const di = new CaffeineIoC({ checks: { circularReferences: true }, decorators: false })
      di.bind(DeferA)
        .toSelf([$i.defer(() => DeferB)])
      di.bind(DeferB)
        .toSelf([DeferA])

      await di.init()

      expect(di.get(DeferA))
        .toBeInstanceOf(DeferA)
    })
  })

  describe('multiple instances of a deferred key — decorated', function () {
    it('should exclude self when consumer is also bound to the abstract key', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const a = di.get(HandlerA)
      expect(a.peers).toHaveLength(2)
      expect(a.peers.some(h => h instanceof HandlerB)).toBe(true)
      expect(a.peers.some(h => h instanceof HandlerC)).toBe(true)
      expect(a.peers.some(h => h instanceof HandlerA)).toBe(false)
    })

    it('should return empty array when consumer is the only implementation', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const a = di.get(SoleHandlerA)
      expect(a.peers).toHaveLength(0)
    })

    it('should collect all implementations when consumer is not bound to the abstract key', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const dispatcher = di.get(Dispatcher)
      expect(dispatcher.handlers).toHaveLength(2)
      expect(dispatcher.handlers.some(h => h instanceof DispatchHandlerA)).toBe(true)
      expect(dispatcher.handlers.some(h => h instanceof DispatchHandlerB)).toBe(true)
    })
  })

  describe('multiple instances of a deferred key', function () {
    it('should exclude self when consumer is also bound to the abstract key', async function () {
      abstract class Handler {}

      class HandlerA extends Handler {
        constructor(readonly peers: Handler[]) { super() }
      }
      class HandlerB extends Handler {}
      class HandlerC extends Handler {}

      const di = new CaffeineIoC({ decorators: false })
      di.bind(HandlerA).toSelf([$i.allOf($i.defer(() => Handler))])
        .extends(Handler)
      di.bind(HandlerB).toSelf()
        .extends(Handler)
      di.bind(HandlerC).toSelf()
        .extends(Handler)
      await di.init()

      const a = di.get(HandlerA)
      expect(a.peers).toHaveLength(2)
      expect(a.peers.some(h => h instanceof HandlerB)).toBe(true)
      expect(a.peers.some(h => h instanceof HandlerC)).toBe(true)
      expect(a.peers.some(h => h instanceof HandlerA)).toBe(false)
    })

    it('should return empty array when consumer is the only implementation', async function () {
      abstract class Handler {}

      class HandlerA extends Handler {
        constructor(readonly peers: Handler[]) { super() }
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(HandlerA).toSelf([$i.allOf($i.defer(() => Handler))])
        .extends(Handler)
      await di.init()

      const a = di.get(HandlerA)
      expect(a.peers).toHaveLength(0)
    })

    it('should collect all implementations when consumer is not bound to the abstract key', async function () {
      abstract class Handler {}

      class HandlerA extends Handler {}
      class HandlerB extends Handler {}

      class Dispatcher {
        constructor(readonly handlers: Handler[]) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(HandlerA).toSelf()
        .extends(Handler)
      di.bind(HandlerB).toSelf()
        .extends(Handler)
      await di.init()

      const dispatcher = di.build(Dispatcher, [$i.allOf($i.defer(() => Handler))])
      expect(dispatcher.handlers).toHaveLength(2)
      expect(dispatcher.handlers.some(h => h instanceof HandlerA)).toBe(true)
      expect(dispatcher.handlers.some(h => h instanceof HandlerB)).toBe(true)
    })
  })

  describe('deferred key in object injection', function () {
    it('should resolve a deferred field in object injection', async function () {
      class DepA {}
      class DepB {}

      class Consumer {
        constructor(readonly deps: { a: DepA, b: DepB }) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(DepA).toSelf()
      di.bind(DepB).toSelf()
      di.bind(Consumer).toSelf([$i.object({ a: $i.defer(() => DepA), b: DepB })])
      await di.init()

      const consumer = di.get(Consumer)
      expect(consumer.deps.a).toBeInstanceOf(DepA)
      expect(consumer.deps.b).toBeInstanceOf(DepB)
    })

    it('should resolve circular deps via deferred field in object injection', async function () {
      class ServiceA {
        constructor(readonly deps: { b: ServiceB }) {}
        tag() { return `a:${this.deps.b.tag()}` }
      }

      class ServiceB {
        constructor(readonly a: ServiceA) {}
        tag() { return 'b' }
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(ServiceA).toSelf([$i.object({ b: $i.defer(() => ServiceB) })])
      di.bind(ServiceB).toSelf([ServiceA])
      await di.init()

      const a = di.get(ServiceA)
      expect(a).toBeInstanceOf(ServiceA)
      expect(a.tag()).toBe('a:b')
    })

    it('should resolve optional deferred field when binding exists', async function () {
      class Dep {}

      class Consumer {
        constructor(readonly deps: { dep?: Dep }) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Dep).toSelf()
      di.bind(Consumer).toSelf([$i.object({ dep: $i.optional($i.defer(() => Dep)) })])
      await di.init()

      const consumer = di.get(Consumer)
      expect(consumer.deps.dep).toBeInstanceOf(Dep)
    })

    it('should resolve optional deferred field as undefined when not bound', async function () {
      class Dep {}

      class Consumer {
        constructor(readonly deps: { dep?: Dep }) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Consumer).toSelf([$i.object({ dep: $i.optional($i.defer(() => Dep)) })])
      await di.init()

      const consumer = di.get(Consumer)
      expect(consumer.deps.dep).toBeUndefined()
    })

    it('should resolve $i.allOf($i.defer()) in object injection', async function () {
      abstract class Handler {}

      class HandlerA extends Handler {}
      class HandlerB extends Handler {}

      class Consumer {
        constructor(readonly deps: { handlers: Handler[] }) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(HandlerA).toSelf()
        .extends(Handler)
      di.bind(HandlerB).toSelf()
        .extends(Handler)
      di.bind(Consumer).toSelf([$i.object({ handlers: $i.allOf($i.defer(() => Handler)) })])
      await di.init()

      const consumer = di.get(Consumer)
      expect(consumer.deps.handlers).toHaveLength(2)
      expect(consumer.deps.handlers.some(h => h instanceof HandlerA)).toBe(true)
      expect(consumer.deps.handlers.some(h => h instanceof HandlerB)).toBe(true)
    })
  })
})
