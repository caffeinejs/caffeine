import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Conditional } from '../decorators/conditional.js'
import { Injectable } from '../decorators/injectable.js'
import { Profile } from '../decorators/profile.js'
import { ErrDuplicateBinding, ErrInvalidContainerState, ErrUnresolvableDependencies } from '../errors.js'
import { token } from '../key.js'
import { mod } from '../module.js'
import { always, never } from './_conditional.js'

// Every binding goes through one registration when the container compiles, however it was made: decorated, bound by
// hand or bound by a module. A key takes one binding; rebind() and overrides() are the ways to replace one.

describe('registration', function () {
  describe('decorated bindings', function () {
    it('registers a class decorated after the container was constructed', async function () {
      const di = new CaffeineIoC({ profiles: ['reg-late'] })

      @Injectable()
      @Profile('reg-late')
      class DecoratedLater {}

      await di.init()

      expect(di.get(DecoratedLater)).toBeInstanceOf(DecoratedLater)
    })
  })

  describe('one binding per key', function () {
    it('refuses a bind() of a class that is already decorated', async function () {
      @Injectable()
      @Profile('reg-dup-decorated')
      class Decorated {}

      const di = new CaffeineIoC({ profiles: ['reg-dup-decorated'] })
      di.bind(Decorated, t => t.toSelf())

      await expect(di.init()).rejects.toThrow(ErrDuplicateBinding)
    })

    it('refuses a module binding a key already bound by hand', async function () {
      const kKey = token<string>(Symbol('reg-dup-module'))

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kKey, t => t.toValue('hand'))
      di.addModules(mod('dup', c => c.bind(kKey, t => t.toValue('module'))))

      await expect(di.init()).rejects.toThrow(ErrDuplicateBinding)
    })

    it('accepts bindings of one key when only one of their profiles is active', async function () {
      const kKey = token<string>(Symbol('reg-profiled'))

      const di = new CaffeineIoC({ decorators: false, profiles: ['a'] })
      di.bind(kKey, t => t.toValue('a').profiles('a'))
      di.bind(kKey, t => t.toValue('b').profiles('b'))
      await di.init()

      expect(di.get(kKey)).toBe('a')
    })

    it('accepts bindings of one key when only one of their conditions passes', async function () {
      const kKey = token<string>(Symbol('reg-conditional'))

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kKey, t => t.toValue('a').conditional(always))
      di.bind(kKey, t => t.toValue('b').conditional(never))
      await di.init()

      expect(di.get(kKey)).toBe('a')
    })

    it('lets a default bound on the absence of its key yield to a decorated class', async function () {
      @Injectable()
      @Profile('reg-default')
      class Clock {
        now(): number {
          return 1
        }
      }

      const di = new CaffeineIoC({ profiles: ['reg-default'] })
      di.bind(Clock, t => t.toValue({ now: () => 2 }).conditional(c => c.missing(Clock)))
      await di.init()

      expect(di.get(Clock).now()).toBe(1)
    })

    it('lets the default register when the decorated class is dropped by its condition', async function () {
      @Injectable()
      @Profile('reg-default-absent')
      @Conditional(never)
      class Clock {
        now(): number {
          return 1
        }
      }

      const di = new CaffeineIoC({ profiles: ['reg-default-absent'] })
      di.bind(Clock, t => t.toValue({ now: () => 2 }).conditional(c => c.missing(Clock)))
      await di.init()

      expect(di.get(Clock).now()).toBe(2)
    })
  })

  describe('rebind()', function () {
    it('replaces a decorated binding', async function () {
      @Injectable()
      @Profile('reg-rebind-decorated')
      class Mailer {
        send(): string {
          return 'real'
        }
      }

      const di = new CaffeineIoC({ profiles: ['reg-rebind-decorated'] })
      di.rebind(Mailer, t => t.toValue({ send: () => 'fake' }))
      await di.init()

      expect(di.get(Mailer).send()).toBe('fake')
    })

    it('replaces a module binding, although the module runs after the rebind() call', async function () {
      const kKey = token<string>(Symbol('reg-rebind-module'))

      const di = new CaffeineIoC({ decorators: false })
      di.addModules(mod('rebind', c => c.bind(kKey, t => t.toValue('module'))))
      di.rebind(kKey, t => t.toValue('replaced'))
      await di.init()

      expect(di.get(kKey)).toBe('replaced')
    })

    it('keeps the conditional bindings of other keys', async function () {
      const kKey = token<string>(Symbol('reg-rebind-key'))
      const kOther = token<string>(Symbol('reg-rebind-other'))

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kOther, t => t.toValue('other').conditional(always))
      di.rebind(kKey, t => t.toValue('replaced'))
      await di.init()

      expect(di.get(kOther)).toBe('other')
      expect(di.get(kKey)).toBe('replaced')
    })

    // A rebind() takes the key from every binding answering to it through a name or a base, which stay registered
    // under their own keys. One still waiting on its conditions used to join the key again once it passed.
    describe('a conditional binding answering to the key', function () {
      abstract class Store {
        abstract kind(): string
      }

      class SqlStore extends Store {
        kind(): string {
          return 'sql'
        }
      }

      class MemoryStore extends Store {
        kind(): string {
          return 'memory'
        }
      }

      it('leaves the replacement alone under a base it extends', async function () {
        const di = new CaffeineIoC({ decorators: false })
        di.bind(SqlStore, t => t.toSelf().extends(Store).conditional(always))
        di.rebind(Store, t => t.toClass(MemoryStore))
        await di.init()

        expect(di.getMany(Store).map(store => store.kind())).toEqual(['memory'])
        expect(di.get(SqlStore).kind()).toBe('sql')
      })

      it('leaves the replacement alone under a name it is bound with', async function () {
        const kStore = token<Store>(Symbol('reg-rebind-named-store'))

        const di = new CaffeineIoC({ decorators: false })
        di.bind(SqlStore, t => t.toSelf().names(kStore).conditional(always))
        di.rebind(kStore, t => t.toClass(MemoryStore))
        await di.init()

        expect(di.getMany(kStore).map(store => store.kind())).toEqual(['memory'])
        expect(di.get(SqlStore).kind()).toBe('sql')
      })
    })
  })

  describe('decorators: false', function () {
    class Dep {}

    @Injectable([Dep])
    @Profile('reg-no-decorators')
    class Consumer {
      constructor(readonly dep?: Dep) {}
    }

    it('ignores the decorators of a class bound by hand', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(Dep, t => t.toSelf())
      di.bind(Consumer, t => t.toSelf())
      await di.init()

      expect(di.get(Consumer).dep).toBeUndefined()
    })

    it('injects what the binding declares', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(Dep, t => t.toSelf())
      di.bind(Consumer, t => t.toSelf([Dep]))
      await di.init()

      expect(di.get(Consumer).dep).toBeInstanceOf(Dep)
    })
  })

  describe('compile()', function () {
    it('registers nothing before it runs', async function () {
      const kKey = token<string>(Symbol('reg-not-yet'))

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kKey, t => t.toValue('value'))

      expect(di.has(kKey)).toBe(false)
      expect([...di.entries()]).toHaveLength(0)

      await di.compile()

      expect(di.has(kKey)).toBe(true)
    })

    it('runs once when init() is called concurrently', async function () {
      const kKey = token<string>(Symbol('reg-concurrent'))

      const di = new CaffeineIoC({ decorators: false })
      di.addModules(mod('once', c => c.bind(kKey, t => t.toValue('module'))))

      await Promise.all([di.init(), di.init(), di.compile()])

      expect(di.get(kKey)).toBe('module')
    })

    it('rejects every later call with the error of a failed compilation', async function () {
      const kKey = token<string>(Symbol('reg-failed'))

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kKey, t => t.toValue('a'))
      di.bind(kKey, t => t.toValue('b'))

      await expect(di.compile()).rejects.toThrow(ErrDuplicateBinding)
      await expect(di.init()).rejects.toThrow(ErrDuplicateBinding)
    })

    it('closes profiles, modules, restore() and overrides() once it has started', async function () {
      const di = new CaffeineIoC({ decorators: false })
      await di.compile()

      expect(() => di.addProfiles('late')).toThrow(ErrInvalidContainerState)
      expect(() => di.addModules(mod('late', () => {}))).toThrow(ErrInvalidContainerState)
      expect(() => di.restore(new CaffeineIoC({ decorators: false }).snapshot())).toThrow(ErrInvalidContainerState)
      expect(() => di.overrides(() => {})).toThrow(ErrInvalidContainerState)
    })
  })

  describe('assertResolvable()', function () {
    it('checks the bindings modules register, before init()', async function () {
      const kMissing = token<string>(Symbol('reg-missing'))
      const kSvc = token<string>(Symbol('reg-svc'))

      const di = new CaffeineIoC({ decorators: false })
      di.addModules(mod('needs', c => c.bind(kSvc, t => t.toFunction((v: string) => v, [kMissing]))))

      await expect(di.assertResolvable()).rejects.toThrow(ErrUnresolvableDependencies)
      expect(di.ready).toBe(false)
    })

    // It registers every binding, so one declared afterwards would miss its conditions, the overrides and the
    // hooks, and init() would go on without it.
    it('refuses a binding declared after it has run', async function () {
      const kKey = token<string>(Symbol('reg-after-assert'))

      const di = new CaffeineIoC({ decorators: false })
      await di.assertResolvable()

      expect(() => di.bind(kKey, t => t.toValue('late').conditional(always))).toThrow(ErrInvalidContainerState)
      expect(() => di.rebind(kKey, t => t.toValue('late'))).toThrow(ErrInvalidContainerState)
    })
  })

  describe('overrides()', function () {
    it('removes a module binding and replaces a decorated one', async function () {
      const kCache = token<string>(Symbol('reg-override-cache'))

      @Injectable()
      @Profile('reg-override')
      class Gateway {
        call(): string {
          return 'real'
        }
      }

      const di = new CaffeineIoC({ profiles: ['reg-override'] })
      di.addModules(mod('infra', c => c.bind(kCache, t => t.toValue('redis'))))
      di.overrides(ops => {
        ops.unbind(kCache)
        ops.rebind(Gateway, t => t.toValue({ call: () => 'fake' }))
      })
      await di.init()

      expect(di.has(kCache)).toBe(false)
      expect(di.get(Gateway).call()).toBe('fake')
    })

    it('sees the conditions already decided', async function () {
      const kFlag = token<boolean>(Symbol('reg-override-flag'))
      const kKey = token<string>(Symbol('reg-override-seen'))
      const seen: boolean[] = []

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kKey, t => t.toValue('conditional').conditional(c => c.present(kFlag)))
      di.overrides(ops => {
        seen.push(ops.has(kKey))
      })
      await di.init()

      expect(seen).toEqual([false])
    })

    it('decides the conditions of a binding it adds', async function () {
      const kKey = token<string>(Symbol('reg-override-added'))

      const di = new CaffeineIoC({ decorators: false })
      di.overrides(ops => {
        ops.bind(kKey, t => t.toValue('added').conditional(c => c.missing(kKey)))
      })
      await di.init()

      expect(di.get(kKey)).toBe('added')
    })

    it('reads the registered bindings', async function () {
      const kKey = token<string>(Symbol('reg-override-read'))
      let keys: unknown[] = []
      let count = 0

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kKey, t => t.toValue('value'))
      di.overrides(ops => {
        keys = [...ops.entries()].map(([key]) => key)
        count = ops.getBindings(kKey).length
      })
      await di.init()

      expect(keys).toContain(kKey)
      expect(count).toBe(1)
    })

    it('runs in the order they were added', async function () {
      const kKey = token<string>(Symbol('reg-override-order'))

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kKey, t => t.toValue('declared'))
      di.overrides(ops => ops.rebind(kKey, t => t.toValue('first')))
      di.overrides(ops => ops.rebind(kKey, t => t.toValue('second')))
      await di.init()

      expect(di.get(kKey)).toBe('second')
    })
  })
})
