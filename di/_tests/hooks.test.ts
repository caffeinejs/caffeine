import { randomUUID } from 'node:crypto'

import { describe, it, expect, vi } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { Configuration } from '../decorators/configuration.js'
import { Lazy } from '../decorators/index.js'
import { Inject } from '../decorators/inject.js'
import { Injectable } from '../decorators/injectable.js'
import { PostConstruct } from '../decorators/post_construct.js'
import { Profile } from '../decorators/profile.js'
import { Provides } from '../decorators/provides.js'
import { ProvidesAsync } from '../decorators/provides_async.js'
import { HookListener } from '../hooks.js'
import { token } from '../key.js'

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
        const di = new CaffeineIoC({ profiles: ['hook-init-fail-sync'], decorators: false })
        di.hooks.on('onBindingInitializationFailed', failListener)
        di.autoWire()

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
        const di = new CaffeineIoC({ profiles: ['hook-init-fail-async'], decorators: false })
        di.hooks.on('onBindingInitializationFailed', failListener)
        di.autoWire()

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
        const di = new CaffeineIoC({ profiles: ['hook-init-sync'], decorators: false })
        di.hooks.on('onBindingInitialized', listener)
        di.autoWire()
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
        const di = new CaffeineIoC({ profiles: ['hook-init-async'], decorators: false })
        di.hooks.on('onBindingInitialized', listener)
        di.autoWire()
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
        const di = new CaffeineIoC({ profiles: ['hook-init-lazy'], decorators: false })
        di.hooks.on('onBindingInitialized', listener)
        di.autoWire()
        await di.init()

        const event = listener.mock.calls.find(([e]) => e.key === LazySvc)
        expect(event).toBeUndefined()
      })
    })
  })

  describe('Container Lifetime Listener', function () {
    const kTest1 = token<string>(Symbol('test1'))
    const kTest2 = token<string>(Symbol('test2'))

    @Injectable()
    class Dep {}

    class Incomplete {
      onDestroy() {}
    }

    class IncompleteWithProp {
      @Inject(token<string>(''))
      message!: string
    }

    @Injectable()
    @ConditionalOn(() => false)
    class NotValid {}

    // Belongs to profile 'test', which the container below does not activate.
    @Injectable()
    @Profile('test')
    class OtherProfile {}

    @Configuration()
    class Conf {
      @Provides(kTest1)
      @ConditionalOn(() => false)
      test1() {
        return 'test1'
      }

      @Provides(kTest2)
      test2() {
        return 'test2'
      }
    }

    it('should announce every decorated binding at autoWire() and report the held ones at init()', async function () {
      const wired: unknown[] = []
      const registered: unknown[] = []
      const notRegistered: unknown[] = []
      const disposed = vi.fn()

      const di = new CaffeineIoC({ decorators: false })

      di.hooks.on('onDecoratedBindingWired', ({ key }) => wired.push(key))
      di.hooks.on('onBindingRegistered', ({ key }) => registered.push(key))
      di.hooks.on('onBindingNotRegistered', ({ key }) => notRegistered.push(key))
      di.hooks.on('onDisposed', disposed)

      di.autoWire()

      // autoWire() only announces: whether a binding registers is decided by the container.
      expect(wired).toEqual(expect.arrayContaining([Dep, NotValid, OtherProfile, Conf, kTest1, kTest2]))
      expect(wired).not.toContain(Incomplete)
      expect(wired).not.toContain(IncompleteWithProp)
      expect(registered).toHaveLength(0)
      expect(notRegistered).toHaveLength(0)

      await di.init()

      // Only the bindings held back until init() are reported. The ones registered at once are not.
      expect(notRegistered).toEqual(expect.arrayContaining([NotValid, OtherProfile, kTest1]))
      expect(notRegistered).not.toContain(kTest2)
      expect(registered).not.toContain(Dep)
      expect(registered).not.toContain(Conf)
      expect(registered).not.toContain(kTest2)
      expect(di.has(kTest2)).toBe(true)

      await di.dispose()

      expect(disposed).toHaveBeenCalledOnce()
    })
  })

  describe('Hook Listener', function () {
    it('should register and emit events multiple times', function () {
      const spy1 = vi.fn()
      const spy2 = vi.fn()
      const spy3 = vi.fn()
      const spy4 = vi.fn()

      const hooks = new HookListener()

      hooks.on('onDecoratedBindingWired', spy1)
      hooks.on('onDecoratedBindingWired', spy2)
      hooks.once('onDecoratedBindingWired', spy3)
      hooks.on('onDisposed', spy4)

      hooks.emit('onDecoratedBindingWired')
      hooks.emit('onDecoratedBindingWired')

      expect(spy1).toHaveBeenCalledTimes(2)
      expect(spy2).toHaveBeenCalledTimes(2)
      expect(spy3).toHaveBeenCalledTimes(1)
      expect(spy4).not.toHaveBeenCalled()

      spy1.mockReset()
      spy2.mockReset()
      spy3.mockReset()
      spy4.mockReset()

      hooks.off('onDecoratedBindingWired', spy1)
      hooks.off('onDisposed', spy2)

      hooks.emit('onDecoratedBindingWired')
      hooks.emit('onDecoratedBindingWired')
      hooks.emit('onDisposed')

      expect(spy1).not.toHaveBeenCalled()
      expect(spy2).toHaveBeenCalledTimes(2)
      expect(spy3).not.toHaveBeenCalled()
      expect(spy4).toHaveBeenCalled()

      spy1.mockReset()
      spy2.mockReset()
      spy3.mockReset()
      spy4.mockReset()

      hooks.removeAllListeners('onDecoratedBindingWired')

      hooks.emit('onDecoratedBindingWired')
      hooks.emit('onDecoratedBindingWired')
      hooks.emit('onDisposed')
      hooks.emit('onDisposed')

      expect(spy1).not.toHaveBeenCalled()
      expect(spy2).not.toHaveBeenCalled()
      expect(spy3).not.toHaveBeenCalled()
      expect(spy4).toHaveBeenCalledTimes(2)
    })

    it('should fail trying to register the same function for the same event', function () {
      const spy = vi.fn()
      const hooks = new HookListener()

      hooks.on('onDecoratedBindingWired', spy)

      expect(() => hooks.on('onDecoratedBindingWired', spy)).toThrow()
      expect(() => hooks.once('onDecoratedBindingWired', spy)).toThrow()
    })

    describe('once() duplicate check', function () {
      it('should throw when once() is called twice with the same listener for the same event', function () {
        const listener = new HookListener()
        const handler = vi.fn()

        listener.once('onDecoratedBindingWired', handler)

        expect(() => listener.once('onDecoratedBindingWired', handler)).toThrow()
      })

      it('should throw when on() is followed by once() with the same listener', function () {
        const listener = new HookListener()
        const handler = vi.fn()

        listener.on('onDecoratedBindingWired', handler)

        expect(() => listener.once('onDecoratedBindingWired', handler)).toThrow()
      })

      it('should throw when once() is followed by on() with the same listener', function () {
        const listener = new HookListener()
        const handler = vi.fn()

        listener.once('onDecoratedBindingWired', handler)

        expect(() => listener.on('onDecoratedBindingWired', handler)).toThrow()
      })

      it('should allow re-registering the same listener after it has fired', function () {
        const listener = new HookListener()
        const handler = vi.fn()

        listener.once('onDecoratedBindingWired', handler)
        listener.emit('onDecoratedBindingWired', {} as any)

        expect(() => listener.once('onDecoratedBindingWired', handler)).not.toThrow()

        listener.emit('onDecoratedBindingWired', {} as any)

        expect(handler).toHaveBeenCalledTimes(2)
      })
    })
  })
})
