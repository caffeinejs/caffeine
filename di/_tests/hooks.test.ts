import { randomUUID } from 'node:crypto'

import { describe, it, expect, vi } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Conditional } from '../decorators/conditional.js'
import { Configuration } from '../decorators/configuration.js'
import { Lazy } from '../decorators/index.js'
import { Inject } from '../decorators/inject.js'
import { Injectable } from '../decorators/injectable.js'
import { PostConstruct } from '../decorators/post_construct.js'
import { Profile } from '../decorators/profile.js'
import { Provides } from '../decorators/provides.js'
import { ProvidesAsync } from '../decorators/provides_async.js'
import { ErrInvalidContainerState } from '../errors.js'
import { HookListener } from '../hooks.js'
import { token } from '../key.js'
import { mod } from '../module.js'
import { always, never } from './_conditional.js'

describe('Hooks', function () {
  describe('On Destroy', function () {
    const destroySpy = vi.fn()
    const destroyAsyncSpy = vi.fn()
    const destroyContainerScopedSpy = vi.fn()

    @Injectable()
    @Profile('hooks-pre-destroy')
    class Dep {
      onDestroy() {
        destroySpy()
      }
    }

    @Injectable()
    @Profile('hooks-pre-destroy')
    class ContainerDep {
      onDestroy() {
        destroyContainerScopedSpy()
      }
    }

    @Injectable()
    @Profile('hooks-pre-destroy')
    class AsyncDep {
      onDestroy(): Promise<void> {
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
      di.bind(Dep, t => t.toSelf())
      await di.init()
      di.get(Dep)

      await di.dispose()

      expect(destroySpy).toHaveBeenCalledTimes(1)
    })

    it('should accept async destroy method', async function () {
      const di = new CaffeineIoC({ decorators: false, profiles: ['hooks-pre-destroy'] })
      di.bind(AsyncDep, t => t.toSelf())
      await di.init()
      di.get(AsyncDep)

      await di.dispose()

      expect(destroyAsyncSpy).toHaveBeenCalledTimes(1)
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

    @Injectable([Dep])
    @Profile('hooks-post-construct')
    class Component {
      id: string = randomUUID()

      @Inject(Prop)
      prop!: Prop

      constructor(readonly dep: Dep) {
        stack.push('ctor')
        expect(this.dep).toBeDefined()
        expect(this.prop).toBeUndefined()
      }

      @PostConstruct()
      init() {
        spy()
        stack.push('init')
        expect(this.dep).toBeDefined()
        expect(this.prop).toBeDefined()
      }
    }

    it('should execute after property injection and any other post providers', async function () {
      const di = new CaffeineIoC({ profiles: ['hooks-post-construct'] })
      await di.init()

      di.get(Component)
      di.get(Component)

      expect(spy).toHaveBeenCalledTimes(1)
      expect(stack).toEqual(['ctor', 'init'])
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
        const di = new CaffeineIoC({ profiles: ['hook-init-fail-sync'] })
        di.hooks.on('onBindingInitializationFailed', failListener)

        await expect(di.init()).rejects.toThrow('sync fail')

        const event = failListener.mock.calls.find(([e]) => e.key === FailSvc)?.[0]
        expect(event).toBeDefined()
        expect(event.async).toBe(false)
        expect(event.error).toBeInstanceOf(Error)
      })
    })

    describe('async binding that rejects', function () {
      class FailAsyncSvc {}

      @Configuration()
      @Profile('hook-init-fail-async')
      class FailAsyncConf {
        @ProvidesAsync(FailAsyncSvc)
        async provideFailAsyncSvc(): Promise<FailAsyncSvc> {
          throw new Error('async fail')
        }
      }
      void FailAsyncConf

      it('fires with async: true when async factory rejects', async function () {
        const failListener = vi.fn()
        const di = new CaffeineIoC({ profiles: ['hook-init-fail-async'] })
        di.hooks.on('onBindingInitializationFailed', failListener)

        await expect(di.init()).rejects.toThrow('async fail')

        const event = failListener.mock.calls.find(([e]) => e.key === FailAsyncSvc)?.[0]

        expect(event).toBeDefined()
        expect(event.async).toBe(true)
        expect(event.error).toBeInstanceOf(Error)
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
        const di = new CaffeineIoC({ profiles: ['hook-init-sync'] })
        di.hooks.on('onBindingInitialized', listener)
        await di.init()

        const event = listener.mock.calls.find(([e]) => e.key === SyncSvc)?.[0]
        expect(event).toBeDefined()
        expect(event.async).toBe(false)
        expect(event.instance).toBe(di.get(SyncSvc))
      })
    })

    describe('async binding', function () {
      class AsyncSvc {
        constructor(readonly value: string) {}
      }

      @Configuration()
      @Profile('hook-init-async')
      class AsyncConf {
        @ProvidesAsync(AsyncSvc)
        async provideAsyncSvc(): Promise<AsyncSvc> {
          return new AsyncSvc('ready')
        }
      }

      it('fires with async: true and matching instance', async function () {
        const listener = vi.fn()
        const di = new CaffeineIoC({ profiles: ['hook-init-async'] })
        di.hooks.on('onBindingInitialized', listener)
        await di.init()

        const event = listener.mock.calls.find(([e]) => e.key === AsyncSvc)?.[0]
        expect(event).toBeDefined()
        expect(event.async).toBe(true)
        expect(event.instance).toBe(di.get(AsyncSvc))
      })
    })

    describe('lazy binding', function () {
      @Injectable()
      @Lazy()
      @Profile('hook-init-lazy')
      class LazySvc {}

      it('does not fire for lazy binding during init()', async function () {
        const listener = vi.fn()
        const di = new CaffeineIoC({ profiles: ['hook-init-lazy'] })
        di.hooks.on('onBindingInitialized', listener)
        await di.init()

        const event = listener.mock.calls.find(([e]) => e.key === LazySvc)
        expect(event).toBeUndefined()
      })
    })
  })

  describe('Container Lifetime Listener', function () {
    const kTest1 = token<string>(Symbol('test1'))
    const kTest2 = token<string>(Symbol('test2'))
    const kHand = token<string>(Symbol('hand'))
    const kModule = token<string>(Symbol('module'))

    @Injectable()
    class Dep {}

    @Injectable()
    @Conditional(never)
    class NotValid {}

    // Belongs to profile 'test'; invisible to the no-profile container below.
    @Injectable()
    @Profile('test')
    class OtherProfile {}

    @Configuration()
    class Conf {
      @Provides(kTest1)
      @Conditional(never)
      test1() {
        return 'test1'
      }

      @Provides(kTest2)
      test2() {
        return 'test2'
      }
    }

    // Listeners attached after construction see every decorated binding, because nothing registers before the
    // container compiles.
    it('should report each decorated binding, then what was registered and what was left out', async function () {
      const decorated: unknown[] = []
      const registered: unknown[] = []
      const dropped: unknown[] = []
      const disposed = vi.fn()

      const di = new CaffeineIoC()
      di.bind(kHand, t => t.toValue('hand'))
      di.addModules(mod('hooks-module', c => c.bind(kModule, t => t.toValue('module'))))

      di.hooks.on('onDecoratedBinding', ({ key }) => decorated.push(key))
      di.hooks.on('onBindingRegistered', ({ key }) => registered.push(key))
      di.hooks.on('onBindingNotRegistered', ({ key }) => dropped.push(key))
      di.hooks.on('onDisposed', disposed)

      await di.init()
      await di.dispose()

      expect(decorated).toEqual(expect.arrayContaining([Dep, NotValid, OtherProfile, Conf, kTest1, kTest2]))
      expect(decorated).not.toContain(kHand)

      expect(registered).toEqual(expect.arrayContaining([Dep, Conf, kTest2, kHand, kModule]))
      expect(registered).not.toEqual(expect.arrayContaining([NotValid]))
      expect(registered).not.toEqual(expect.arrayContaining([OtherProfile]))
      expect(registered).not.toEqual(expect.arrayContaining([kTest1]))

      expect(dropped).toEqual(expect.arrayContaining([NotValid, OtherProfile, kTest1]))
      expect(disposed).toHaveBeenCalledOnce()
    })

    // The registration hooks fire once every binding is registered and decided, so a binding a listener makes would
    // miss its conditions: one with conditions was accepted and then never decided nor reported.
    it('should refuse a binding a registration listener makes, with conditions or not', async function () {
      const kSeen = token<string>(Symbol('hooks-seen'))
      const kLate = token<string>(Symbol('hooks-late'))

      for (const conditions of [[], [always]]) {
        const di = new CaffeineIoC({ decorators: false })
        di.bind(kSeen, t => t.toValue('seen'))
        di.hooks.on('onBindingRegistered', () => {
          di.bind(kLate, t => t.toValue('late').conditional(conditions))
        })

        await expect(di.init()).rejects.toThrow(ErrInvalidContainerState)
      }
    })
  })

  describe('Hook Listener', function () {
    it('should register and emit events multiple times', function () {
      const spy1 = vi.fn()
      const spy2 = vi.fn()
      const spy3 = vi.fn()
      const spy4 = vi.fn()

      const hooks = new HookListener()

      hooks.on('onDisposed', spy1)
      hooks.on('onDisposed', spy2)
      hooks.once('onDisposed', spy3)
      hooks.on('onModuleRegistered', spy4)

      hooks.emit('onDisposed')
      hooks.emit('onDisposed')

      expect(spy1).toHaveBeenCalledTimes(2)
      expect(spy2).toHaveBeenCalledTimes(2)
      expect(spy3).toHaveBeenCalledTimes(1)
      expect(spy4).not.toHaveBeenCalled()

      spy1.mockReset()
      spy2.mockReset()
      spy3.mockReset()
      spy4.mockReset()

      hooks.off('onDisposed', spy1)
      hooks.off('onModuleRegistered', spy2)

      hooks.emit('onDisposed')
      hooks.emit('onDisposed')
      hooks.emit('onModuleRegistered')

      expect(spy1).not.toHaveBeenCalled()
      expect(spy2).toHaveBeenCalledTimes(2)
      expect(spy3).not.toHaveBeenCalled()
      expect(spy4).toHaveBeenCalled()

      spy1.mockReset()
      spy2.mockReset()
      spy3.mockReset()
      spy4.mockReset()

      hooks.removeAllListeners('onDisposed')

      hooks.emit('onDisposed')
      hooks.emit('onDisposed')
      hooks.emit('onModuleRegistered')
      hooks.emit('onModuleRegistered')

      expect(spy1).not.toHaveBeenCalled()
      expect(spy2).not.toHaveBeenCalled()
      expect(spy3).not.toHaveBeenCalled()
      expect(spy4).toHaveBeenCalledTimes(2)
    })

    it('should fail trying to register the same function for the same event', function () {
      const spy = vi.fn()
      const hooks = new HookListener()

      hooks.on('onDisposed', spy)

      expect(() => hooks.on('onDisposed', spy)).toThrow()
      expect(() => hooks.once('onDisposed', spy)).toThrow()
    })

    describe('once() duplicate check', function () {
      it('should throw when once() is called twice with the same listener for the same event', function () {
        const listener = new HookListener()
        const handler = vi.fn()

        listener.once('onDecoratedBinding', handler)

        expect(() => listener.once('onDecoratedBinding', handler)).toThrow()
      })

      it('should throw when on() is followed by once() with the same listener', function () {
        const listener = new HookListener()
        const handler = vi.fn()

        listener.on('onDecoratedBinding', handler)

        expect(() => listener.once('onDecoratedBinding', handler)).toThrow()
      })

      it('should throw when once() is followed by on() with the same listener', function () {
        const listener = new HookListener()
        const handler = vi.fn()

        listener.once('onDecoratedBinding', handler)

        expect(() => listener.on('onDecoratedBinding', handler)).toThrow()
      })

      it('should allow re-registering the same listener after it has fired', function () {
        const listener = new HookListener()
        const handler = vi.fn()

        listener.once('onDecoratedBinding', handler)
        listener.emit('onDecoratedBinding', {} as any)

        expect(() => listener.once('onDecoratedBinding', handler)).not.toThrow()

        listener.emit('onDecoratedBinding', {} as any)

        expect(handler).toHaveBeenCalledTimes(2)
      })
    })
  })
})
