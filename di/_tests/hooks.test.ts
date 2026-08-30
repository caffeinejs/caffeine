import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { token } from '../key.js'
import { Async } from '../decorators/async.js'
import { Configuration } from '../decorators/configuration.js'
import { Injectable } from '../decorators/injectable.js'
import { Profile } from '../decorators/profile.js'
import { PostConstruct } from '../decorators/post_construct.js'
import { PreDestroy } from '../decorators/pre_destroy.js'
import { Provides } from '../decorators/provides.js'
import { CaffeineIoC } from '../container.js'
import { Inject } from '../decorators/inject.js'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { HookListener } from '../hooks.js'
import { Lazy } from '../decorators/index.js'

describe('Hooks', function () {
  describe('Pre Destroy', function () {
    const destroySpy = vi.fn()
    const destroyAsyncSpy = vi.fn()
    const destroyContainerScopedSpy = vi.fn()

    @Injectable()
    @Profile('hooks-pre-destroy')
    class Dep {
      @PreDestroy()
      destroy() {
        destroySpy()
      }
    }

    @Injectable()
    @Profile('hooks-pre-destroy')
    class ContainerDep {
      @PreDestroy()
      destroy() {
        destroyContainerScopedSpy()
      }
    }

    @Injectable()
    @Profile('hooks-pre-destroy')
    class AsyncDep {
      @PreDestroy()
      destroy(): Promise<void> {
        return new Promise(resolve =>
          setTimeout(() => {
            destroyAsyncSpy()
            return resolve()
          }, 100),
        )
      }
    }

    it('should call method marked as on destroy when instance is a singleton', async function () {
      const di = new CaffeineIoC({ decorators: false, profiles: ['hooks-pre-destroy'] })
      di.bind(Dep)
        .toSelf()
      await di.init()
      di.get(Dep)

      await di.dispose()

      expect(destroySpy)
        .toHaveBeenCalledTimes(1)
    })

    it('should accept async destroy method', async function () {
      const di = new CaffeineIoC({ decorators: false, profiles: ['hooks-pre-destroy'] })
      di.bind(AsyncDep)
        .toSelf()
      await di.init()
      di.get(AsyncDep)

      await di.dispose()

      expect(destroyAsyncSpy)
        .toHaveBeenCalledTimes(1)
    })
  })

  describe('Post Construct', function () {
    const stack: string[] = []
    const spy = vi.fn()

    @Injectable()
    @Profile('hooks-post-construct')
    class Dep {}

    @Injectable()
    @Profile('hooks-post-construct')
    class Prop {}

    @Injectable()
    @Profile('hooks-post-construct')
    class Svc {}

    @Injectable([Dep])
    @Profile('hooks-post-construct')
    class Component {
      id: string = randomUUID()

      @Inject(Prop)
      prop!: Prop

      svc!: Svc

      constructor(readonly dep: Dep) {
        stack.push('ctor')
        expect(this.dep)
          .toBeDefined()
        expect(this.prop)
          .toBeUndefined()
        expect(this.svc)
          .toBeUndefined()
      }

      @PostConstruct()
      init() {
        spy()
        stack.push('init')
        expect(this.dep)
          .toBeDefined()
        expect(this.svc)
          .toBeDefined()
        expect(this.prop)
          .toBeDefined()
      }

      @Inject([Svc])
      setSvc(svc: Svc) {
        this.svc = svc
        stack.push('method')
      }
    }

    it('should execute after property, method and any other post providers', async function () {
      const di = new CaffeineIoC({ profiles: ['hooks-post-construct'] })
      await di.init()

      di.get(Component)
      di.get(Component)

      expect(spy)
        .toHaveBeenCalledTimes(1)
      expect(stack)
        .toEqual(['ctor', 'method', 'init'])
    })
  })

  describe('onBindingInitializationFailed', function () {
    describe('sync binding that throws', function () {
      @Injectable()
      @Profile('hook-init-fail-sync')
      class FailSvc {
        constructor() {
          throw new Error('sync fail')
        }
      }

      it('fires with async: false when sync factory throws', async function () {
        const failListener = vi.fn()
        const di = new CaffeineIoC({ profiles: ['hook-init-fail-sync'], decorators: false })
        di.hooks.on('onBindingInitializationFailed', failListener)
        di.autoWire()

        await expect(di.init()).rejects.toThrow('sync fail')

        const event = failListener.mock.calls.find(([e]) => e.key === FailSvc)?.[0]
        expect(event)
          .toBeDefined()
        expect(event.async)
          .toBe(false)
        expect(event.error)
          .toBeInstanceOf(Error)
      })
    })

    describe('async binding that rejects', function () {
      class FailAsyncSvc {}

      @Configuration()
      @Profile('hook-init-fail-async')
      class FailAsyncConf {
        @Async()
        @Provides(FailAsyncSvc)
        async provideFailAsyncSvc(): Promise<FailAsyncSvc> {
          throw new Error('async fail')
        }
      }
      void FailAsyncConf

      it('fires with async: true when async factory rejects', async function () {
        const failListener = vi.fn()
        const di = new CaffeineIoC({ profiles: ['hook-init-fail-async'], decorators: false })
        di.hooks.on('onBindingInitializationFailed', failListener)
        di.autoWire()

        await expect(di.init()).rejects.toThrow('async fail')

        const event = failListener.mock.calls.find(([e]) => e.key === FailAsyncSvc)?.[0]

        expect(event)
          .toBeDefined()
        expect(event.async)
          .toBe(true)
        expect(event.error)
          .toBeInstanceOf(Error)
      })
    })
  })

  describe('onBindingInitialized hook', function () {
    describe('sync eager binding', function () {
      @Injectable()
      @Profile('hook-init-sync')
      class SyncSvc {}

      it('fires with async: false and matching instance', async function () {
        const listener = vi.fn()
        const di = new CaffeineIoC({ profiles: ['hook-init-sync'], decorators: false })
        di.hooks.on('onBindingInitialized', listener)
        di.autoWire()
        await di.init()

        const event = listener.mock.calls.find(([e]) => e.key === SyncSvc)?.[0]
        expect(event)
          .toBeDefined()
        expect(event.async)
          .toBe(false)
        expect(event.instance)
          .toBe(di.get(SyncSvc))
      })
    })

    describe('async binding', function () {
      class AsyncSvc {
        constructor(readonly value: string) {}
      }

      @Configuration()
      @Profile('hook-init-async')
      class AsyncConf {
        @Async()
        @Provides(AsyncSvc)
        async provideAsyncSvc(): Promise<AsyncSvc> {
          return new AsyncSvc('ready')
        }
      }

      it('fires with async: true and matching instance', async function () {
        const listener = vi.fn()
        const di = new CaffeineIoC({ profiles: ['hook-init-async'], decorators: false })
        di.hooks.on('onBindingInitialized', listener)
        di.autoWire()
        await di.init()

        const event = listener.mock.calls.find(([e]) => e.key === AsyncSvc)?.[0]
        expect(event)
          .toBeDefined()
        expect(event.async)
          .toBe(true)
        expect(event.instance)
          .toBe(di.get(AsyncSvc))
      })
    })

    describe('lazy binding', function () {
      @Injectable()
      @Lazy()
      @Profile('hook-init-lazy')
      class LazySvc {}

      it('does not fire for lazy binding during init()', async function () {
        const listener = vi.fn()
        const di = new CaffeineIoC({ profiles: ['hook-init-lazy'], decorators: false })
        di.hooks.on('onBindingInitialized', listener)
        di.autoWire()
        await di.init()

        const event = listener.mock.calls.find(([e]) => e.key === LazySvc)
        expect(event)
          .toBeUndefined()
      })
    })
  })

  describe('Container Lifetime Listener', function () {
    const spy = vi.fn()

    // 1
    @Injectable()
    class Dep {}

    // 1
    class Incomplete {
      @PreDestroy()
      hi() {}
    }

    // 1
    class IncompleteWithProp {
      @Inject(token<any>(''))
      message!: string
    }

    // 2
    @Injectable()
    @ConditionalOn(() => false)
    class NotValid {}

    // 3 - belongs to profile 'test'; invisible to the no-profile container below
    @Injectable()
    @Profile('test')
    class OtherProfile {}

    // 4
    @Configuration()
    class Conf {
      // 5
      @Provides(token<any>(Symbol('test1')))
      @ConditionalOn(() => false)
      test1() {
        return 'test1'
      }

      // 6
      @Provides(token<any>(Symbol('test2')))
      test2() {
        return 'test2'
      }
    }

    it('should call inspector methods on container specific registration steps', async function () {
      const di = new CaffeineIoC({ decorators: false })

      di.hooks.on('onSetup', a => spy())
      di.hooks.on('onBindingRegistered', a => spy())
      di.hooks.on('onBindingNotRegistered', a => spy())
      di.hooks.on('onSetupComplete', a => spy())
      di.hooks.on('onDisposed', a => spy())

      di.autoWire()
      await di.init()

      await di.dispose()

      expect(spy)
        .toHaveBeenCalledTimes(12)
    })
  })

  describe('Hook Listener', function () {
    it('should register and emit events multiple times', function () {
      const spy1 = vi.fn()
      const spy2 = vi.fn()
      const spy3 = vi.fn()
      const spy4 = vi.fn()

      const hooks = new HookListener()

      hooks.on('onSetupComplete', spy1)
      hooks.on('onSetupComplete', spy2)
      hooks.once('onSetupComplete', spy3)
      hooks.on('onDisposed', spy4)

      hooks.emit('onSetupComplete')
      hooks.emit('onSetupComplete')

      expect(spy1)
        .toHaveBeenCalledTimes(2)
      expect(spy2)
        .toHaveBeenCalledTimes(2)
      expect(spy3)
        .toHaveBeenCalledTimes(1)
      expect(spy4).not.toHaveBeenCalled()

      spy1.mockReset()
      spy2.mockReset()
      spy3.mockReset()
      spy4.mockReset()

      hooks.off('onSetupComplete', spy1)
      hooks.off('onDisposed', spy2)

      hooks.emit('onSetupComplete')
      hooks.emit('onSetupComplete')
      hooks.emit('onDisposed')

      expect(spy1).not.toHaveBeenCalled()
      expect(spy2)
        .toHaveBeenCalledTimes(2)
      expect(spy3).not.toHaveBeenCalled()
      expect(spy4)
        .toHaveBeenCalled()

      spy1.mockReset()
      spy2.mockReset()
      spy3.mockReset()
      spy4.mockReset()

      hooks.removeAllListeners('onSetupComplete')

      hooks.emit('onSetupComplete')
      hooks.emit('onSetupComplete')
      hooks.emit('onDisposed')
      hooks.emit('onDisposed')

      expect(spy1).not.toHaveBeenCalled()
      expect(spy2).not.toHaveBeenCalled()
      expect(spy3).not.toHaveBeenCalled()
      expect(spy4)
        .toHaveBeenCalledTimes(2)
    })

    it('should fail trying to register the same function for the same event', function () {
      const spy = vi.fn()
      const hooks = new HookListener()

      hooks.on('onSetupComplete', spy)

      expect(() => hooks.on('onSetupComplete', spy))
        .toThrow()
      expect(() => hooks.once('onSetupComplete', spy))
        .toThrow()
    })

    describe('once() duplicate check', function () {
      it('should throw when once() is called twice with the same listener for the same event', function () {
        const listener = new HookListener()
        const handler = vi.fn()

        listener.once('onSetup', handler)

        expect(() => listener.once('onSetup', handler))
          .toThrow()
      })

      it('should throw when on() is followed by once() with the same listener', function () {
        const listener = new HookListener()
        const handler = vi.fn()

        listener.on('onSetup', handler)

        expect(() => listener.once('onSetup', handler))
          .toThrow()
      })

      it('should throw when once() is followed by on() with the same listener', function () {
        const listener = new HookListener()
        const handler = vi.fn()

        listener.once('onSetup', handler)

        expect(() => listener.on('onSetup', handler))
          .toThrow()
      })

      it('should allow re-registering the same listener after it has fired', function () {
        const listener = new HookListener()
        const handler = vi.fn()

        listener.once('onSetup', handler)
        listener.emit('onSetup', {} as any)

        expect(() => listener.once('onSetup', handler)).not.toThrow()

        listener.emit('onSetup', {} as any)

        expect(handler)
          .toHaveBeenCalledTimes(2)
      })
    })
  })
})
