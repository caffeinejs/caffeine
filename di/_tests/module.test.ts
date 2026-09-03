import { beforeEach, describe, expect, it, vi } from 'vitest'
import { token } from '../key.js'
import { CaffeineIoC } from '../container.js'
import { ContainerBindingOps } from '../container_interface.js'
import { ErrInvalidContainerState } from '../errors.js'
import { kModule, mod, type Module, type ModuleFn } from '../module.js'
import { alphaModule } from './_testdata/circular_modules/nested/alpha.mod.js'
import { betaModule } from './_testdata/circular_modules/nested/beta.mod.js'
import { OrderService } from './_testdata/circular_modules/shop/order.service.js'
import { ordersModule } from './_testdata/circular_modules/shop/orders.mod.js'
import { UserNotifier } from './_testdata/circular_modules/shop/user.notifier.js'
import { UserRepository } from './_testdata/circular_modules/shop/user.repository.js'
import { usersModule } from './_testdata/circular_modules/shop/users.mod.js'
import { moduleFnCalls, resetModuleFnCalls } from './_testdata/circular_modules/trace.js'
import { Catalog } from './_testdata/circular_modules/triad/catalog.js'
import { catalogModule } from './_testdata/circular_modules/triad/catalog.mod.js'
import { Inventory } from './_testdata/circular_modules/triad/inventory.js'
import { inventoryModule } from './_testdata/circular_modules/triad/inventory.mod.js'
import { Pricing } from './_testdata/circular_modules/triad/pricing.js'

class Svc {
  value = 'from-module'
}

class OtherSvc {
  value = 'other'
}

describe('Module', function () {
  describe('new CaffeineIoC({ modules })', function () {
    it('should execute a single module and register its bindings', async function () {
      const module: ModuleFn = (container: ContainerBindingOps) => {
        container.bind(Svc, t => t
          .toSelf())
      }

      const di = new CaffeineIoC({ decorators: false, modules: [module] })
      await di.init()

      expect(di.get(Svc))
        .toBeInstanceOf(Svc)
    })

    it('should execute multiple modules in order', async function () {
      const order: number[] = []

      const mod1: ModuleFn = () => {
        order.push(1)
      }
      const mod2: ModuleFn = () => {
        order.push(2)
      }
      const mod3: ModuleFn = () => {
        order.push(3)
      }

      const di = new CaffeineIoC({ decorators: false, modules: [mod1, mod2, mod3] })
      await di.init()

      expect(order)
        .toEqual([1, 2, 3])
    })

    it('should give each module access to the container', async function () {
      const module: ModuleFn = (container: ContainerBindingOps) => {
        container.bind(token<any>('key'), t => t
          .toValue('value'))
      }

      const di = new CaffeineIoC({ decorators: false, modules: [module] })
      await di.init()

      expect(di.get(token<any>('key')))
        .toBe('value')
    })

    it('should execute modules during init', async function () {
      let moduleCalled = false

      const module: ModuleFn = () => {
        moduleCalled = true
      }

      const di = new CaffeineIoC({ decorators: false, modules: [module] })
      await di.init()

      expect(moduleCalled)
        .toBe(true)
    })

    it('should support multiple modules each registering different bindings', async function () {
      const modA: ModuleFn = (container: ContainerBindingOps) => {
        container.bind(Svc, t => t
          .toSelf())
      }
      const modB: ModuleFn = (container: ContainerBindingOps) => {
        container.bind(OtherSvc, t => t
          .toSelf())
      }

      const di = new CaffeineIoC({ decorators: false, modules: [modA, modB] })
      await di.init()

      expect(di.get(Svc))
        .toBeInstanceOf(Svc)
      expect(di.get(OtherSvc))
        .toBeInstanceOf(OtherSvc)
    })

    it('should work with no modules', async function () {
      const di = new CaffeineIoC({ decorators: false })
      await expect(di.init()).resolves.toBeUndefined()
    })

    it('should execute modules after autoWire', async function () {
      const module: ModuleFn = (container: ContainerBindingOps) => {
        container.bind(token<any>('manual-key'), t => t
          .toValue('manual-value'))
      }

      const di = new CaffeineIoC({ modules: [module] })
      await di.init()

      expect(di.get(token<any>('manual-key')))
        .toBe('manual-value')
    })

    it('should coexist with auto-wired bindings', async function () {
      const kToken = token<any>(Symbol('module-test-token'))
      const module: ModuleFn = (container: ContainerBindingOps) => {
        container.bind(kToken, t => t
          .toValue(42))
      }

      const di = new CaffeineIoC({ modules: [module] })
      await di.init()

      expect(di.get(kToken))
        .toBe(42)
    })

    it('should copy options.modules so later mutation of the caller array is ignored', async function () {
      const order: number[] = []
      const modules: ModuleFn[] = [() => {
        order.push(1)
      }]

      const di = new CaffeineIoC({ decorators: false, modules })
      modules.push(() => {
        order.push(2)
      })
      await di.init()

      expect(order)
        .toEqual([1])
    })
  })

  describe('addModules', function () {
    it('should register a module queued before init', async function () {
      const module: ModuleFn = (container: ContainerBindingOps) => {
        container.bind(Svc, t => t.toSelf())
      }

      const di = new CaffeineIoC({ decorators: false })
      di.addModules(module)
      await di.init()

      expect(di.get(Svc)).toBeInstanceOf(Svc)
    })

    it('should register multiple modules queued before init', async function () {
      const modA: ModuleFn = (container: ContainerBindingOps) => {
        container.bind(Svc, t => t.toSelf())
      }
      const modB: ModuleFn = (container: ContainerBindingOps) => {
        container.bind(OtherSvc, t => t.toSelf())
      }

      const di = new CaffeineIoC({ decorators: false })
      di.addModules(modA, modB)
      await di.init()

      expect(di.get(Svc)).toBeInstanceOf(Svc)
      expect(di.get(OtherSvc)).toBeInstanceOf(OtherSvc)
    })

    it('should execute modules added via addModules after constructor modules', async function () {
      const order: number[] = []

      const ctorMod: ModuleFn = () => {
        order.push(1)
      }
      const addedMod: ModuleFn = () => {
        order.push(2)
      }

      const di = new CaffeineIoC({ decorators: false, modules: [ctorMod] })
      di.addModules(addedMod)
      await di.init()

      expect(order).toEqual([1, 2])
    })

    it('should support multiple addModules calls accumulating in order', async function () {
      const order: number[] = []

      const di = new CaffeineIoC({ decorators: false })
      di.addModules(() => {
        order.push(1)
      })
      di.addModules(() => {
        order.push(2)
      }, () => {
        order.push(3)
      })
      await di.init()

      expect(order).toEqual([1, 2, 3])
    })

    it('should throw ErrInvalidContainerState when called after init', async function () {
      const di = new CaffeineIoC({ decorators: false })
      await di.init()

      expect(() => di.addModules(() => {})).toThrow(ErrInvalidContainerState)
    })

    it('should emit onModuleRegistered for module added via addModules', async function () {
      const events: { name: string, index: number }[] = []
      const namedMod = mod('AddedModule', () => {})

      const di = new CaffeineIoC({ decorators: false })
      di.addModules(namedMod)
      di.hooks.on('onModuleRegistered', e => events.push(e))
      await di.init()

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ name: 'AddedModule', index: 0 })
    })

    it('should await async module added via addModules', async function () {
      let resolved = false

      const module: ModuleFn = () =>
        new Promise<void>(resolve => {
          setTimeout(() => {
            resolved = true
            resolve()
          }, 0)
        })

      const di = new CaffeineIoC({ decorators: false })
      di.addModules(module)
      await di.init()

      expect(resolved).toBe(true)
    })
  })

  describe('async modules', function () {
    it('should await a Promise-returning module', async function () {
      let resolved = false

      const module: ModuleFn = () =>
        new Promise<void>(resolve => {
          setTimeout(() => {
            resolved = true
            resolve()
          }, 0)
        })

      const di = new CaffeineIoC({ decorators: false, modules: [module] })
      await di.init()

      expect(resolved)
        .toBe(true)
    })
  })

  describe('module hooks', function () {
    it('should emit onModuleRegistered after a successful module', async function () {
      const events: { name: string, index: number }[] = []

      const module: ModuleFn = () => {}

      const di = new CaffeineIoC({ decorators: false, modules: [module] })
      di.hooks.on('onModuleRegistered', e => events.push(e))
      await di.init()

      expect(events)
        .toHaveLength(1)
      expect(events[0])
        .toMatchObject({ index: 0 })
    })

    it('should emit onModuleRegistered with mod() name', async function () {
      const events: { name: string, index: number }[] = []

      const module = mod('PaymentModule', () => {})

      const di = new CaffeineIoC({ decorators: false, modules: [module] })
      di.hooks.on('onModuleRegistered', e => events.push(e))
      await di.init()

      expect(events[0])
        .toMatchObject({ name: 'PaymentModule', index: 0 })
    })

    it('should emit onModuleRegistered for each module in order', async function () {
      const events: { name: string, index: number }[] = []

      const mod1 = mod('Mod1', () => {})
      const mod2 = mod('Mod2', () => {})
      const mod3 = mod('Mod3', () => {})

      const di = new CaffeineIoC({ decorators: false, modules: [mod1, mod2, mod3] })
      di.hooks.on('onModuleRegistered', e => events.push(e))
      await di.init()

      expect(events)
        .toHaveLength(3)
      expect(events.map(e => e.index))
        .toEqual([0, 1, 2])
      expect(events.map(e => e.name))
        .toEqual(['Mod1', 'Mod2', 'Mod3'])
    })

    it('should emit onModuleRegistrationFailed when module rejects', async function () {
      const error = new Error('module failure')
      const failures: { name: string, index: number, error: Error }[] = []

      const module: ModuleFn = () => Promise.reject(error)

      const di = new CaffeineIoC({ decorators: false, modules: [module] })
      di.hooks.on('onModuleRegistrationFailed', e => failures.push(e))

      await expect(di.init()).rejects.toThrow(error)

      expect(failures)
        .toHaveLength(1)
      expect(failures[0])
        .toMatchObject({ index: 0, error })
    })

    it('should emit onModuleRegistrationFailed with mod() name when module rejects', async function () {
      const error = new Error('module failure')
      const failures: { name: string, index: number, error: Error }[] = []

      const module = mod('FailingModule', () => Promise.reject(error))

      const di = new CaffeineIoC({ decorators: false, modules: [module] })
      di.hooks.on('onModuleRegistrationFailed', e => failures.push(e))

      await expect(di.init()).rejects.toThrow(error)

      expect(failures[0])
        .toMatchObject({ name: 'FailingModule', index: 0, error })
    })

    it('should not emit onModuleRegistered when module rejects', async function () {
      const registered: unknown[] = []

      const module: ModuleFn = () => Promise.reject(new Error('boom'))

      const di = new CaffeineIoC({ decorators: false, modules: [module] })
      di.hooks.on('onModuleRegistered', e => registered.push(e))

      await expect(di.init()).rejects.toThrow()

      expect(registered)
        .toHaveLength(0)
    })

    it('should emit onModuleRegistrationFailed when module throws synchronously', async function () {
      const error = new Error('sync failure')
      const failures: { name: string, index: number, error: Error }[] = []

      const module: ModuleFn = () => {
        throw error
      }

      const di = new CaffeineIoC({ decorators: false, modules: [module] })
      di.hooks.on('onModuleRegistrationFailed', e => failures.push(e))

      await expect(di.init()).rejects.toThrow(error)

      expect(failures)
        .toHaveLength(1)
      expect(failures[0])
        .toMatchObject({ index: 0, error })
    })

    it('should not emit onModuleRegistered when module throws synchronously', async function () {
      const registered: unknown[] = []

      const module: ModuleFn = () => {
        throw new Error('sync boom')
      }

      const di = new CaffeineIoC({ decorators: false, modules: [module] })
      di.hooks.on('onModuleRegistered', e => registered.push(e))

      await expect(di.init()).rejects.toThrow()

      expect(registered)
        .toHaveLength(0)
    })
  })

  describe('mod()', function () {
    it('should build a Module object from a name and fn', function () {
      const fn: ModuleFn = () => {}
      const module = mod('order', fn)

      expect(module.name).toBe('order')
      expect(module.fn).toBe(fn)
      expect(module.needs).toBeUndefined()
      expect(module.provides).toBeUndefined()
      expect((module as any)[kModule]).toBe(true)
    })

    it('should stamp the same object and leave missing needs/provides unset', function () {
      const fn: ModuleFn = () => {}
      const raw: Module = { name: 'users', fn }
      const stamped = mod(raw)

      expect(stamped).toBe(raw)
      expect(stamped.needs).toBeUndefined()
      expect(stamped.provides).toBeUndefined()
      expect((stamped as any)[kModule]).toBe(true)
    })

    it('should not call needs or provides', function () {
      const needs = vi.fn(() => [])
      const provides = vi.fn(() => [])
      mod({ name: 'x', needs, provides })

      expect(needs).not.toHaveBeenCalled()
      expect(provides).not.toHaveBeenCalled()
    })

    it('should run a module object that omits needs and provides', async function () {
      const spy = vi.fn()
      const di = new CaffeineIoC({
        decorators: false,
        modules: [mod({ name: 'bare', fn: spy })],
      })
      await di.init()

      expect(spy).toHaveBeenCalledTimes(1)
    })
  })

  describe('module graph', function () {
    it('should run needs before fn on a DAG', async function () {
      const order: string[] = []
      const dep = mod('dep', () => {
        order.push('dep')
      })
      const parent = mod({
        name: 'parent',
        needs: () => [dep],
        fn: () => {
          order.push('parent')
        },
      })

      const di = new CaffeineIoC({ decorators: false, modules: [parent] })
      await di.init()

      expect(order).toEqual(['dep', 'parent'])
    })

    it('should collect nested provides modules before fn', async function () {
      const order: string[] = []
      const inner = mod('inner', () => {
        order.push('inner')
      })
      const outer = mod({
        name: 'outer',
        provides: () => [inner],
        fn: () => {
          order.push('outer')
        },
      })

      const di = new CaffeineIoC({ decorators: false, modules: [outer] })
      await di.init()

      expect(order).toEqual(['inner', 'outer'])
    })

    it('should run a diamond dependency fn once', async function () {
      const spy = vi.fn()
      const shared = mod('shared', spy)
      const left = mod({
        name: 'left',
        needs: () => [shared],
      })
      const right = mod({
        name: 'right',
        needs: () => [shared],
      })

      const di = new CaffeineIoC({ decorators: false, modules: [left, right] })
      await di.init()

      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('should run a module once when passed via options and needs', async function () {
      const spy = vi.fn()
      const leaf = mod('leaf', spy)
      const parent = mod({
        name: 'parent',
        needs: () => [leaf],
      })

      const di = new CaffeineIoC({ decorators: false, modules: [leaf, parent] })
      await di.init()

      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('should run modules with the same name and different fns both', async function () {
      const order: string[] = []
      const a = mod('dup', () => {
        order.push('a')
      })
      const b = mod('dup', () => {
        order.push('b')
      })

      const di = new CaffeineIoC({ decorators: false, modules: [a, b] })
      await di.init()

      expect(order).toEqual(['a', 'b'])
    })

    it('should not auto-bind a Ctor listed in provides', async function () {
      class NotBound {}

      const module = mod({
        name: 'provides-ctor',
        provides: () => [NotBound],
      })

      const di = new CaffeineIoC({ decorators: false, modules: [module] })
      await di.init()

      expect(di.has(NotBound)).toBe(false)
    })

    it('should not throw on a needs cycle and run each fn once', async function () {
      const order: string[] = []
      const a: Module = {
        name: 'a',
        needs: () => [b],
        fn: () => {
          order.push('a')
        },
      }
      const b: Module = {
        name: 'b',
        needs: () => [a],
        fn: () => {
          order.push('b')
        },
      }
      mod(a)
      mod(b)

      const di = new CaffeineIoC({ decorators: false, modules: [a] })
      await di.init()

      expect(order).toHaveLength(2)
      expect(order).toContain('a')
      expect(order).toContain('b')
    })

    it('should collect children from a provides-only root', async function () {
      const order: string[] = []
      const a = mod('a', () => {
        order.push('a')
      })
      const b = mod('b', () => {
        order.push('b')
      })
      const c = mod('c', () => {
        order.push('c')
      })
      const root = mod({
        name: 'root',
        provides: () => [a, b, c],
      })

      const di = new CaffeineIoC({ decorators: false, modules: [root] })
      await di.init()

      expect(order).toEqual(['a', 'b', 'c'])
    })

    it('should collect a cycle among provided children and run each fn once', async function () {
      const order: string[] = []
      const a: Module = {
        name: 'a',
        needs: () => [b],
        fn: () => {
          order.push('a')
        },
      }
      const b: Module = {
        name: 'b',
        needs: () => [a],
        fn: () => {
          order.push('b')
        },
      }
      mod(a)
      mod(b)
      const root = mod({
        name: 'root',
        provides: () => [a, b],
      })

      const di = new CaffeineIoC({ decorators: false, modules: [root] })
      await di.init()

      expect(order).toHaveLength(2)
      expect(order.filter(n => n === 'a')).toHaveLength(1)
      expect(order.filter(n => n === 'b')).toHaveLength(1)
    })

    it('should collect a long needs chain from a provides-only root', async function () {
      const order: number[] = []
      const chain: Module[] = []
      for (let i = 0; i < 64; i++) {
        const index = i
        chain.push(mod({
          name: `n${index}`,
          needs: () => (index === 0 ? [] : [chain[index - 1]]),
          fn: () => {
            order.push(index)
          },
        }))
      }
      const root = mod({
        name: 'root',
        provides: () => [chain[63]],
      })

      const di = new CaffeineIoC({ decorators: false, modules: [root] })
      await di.init()

      expect(order).toHaveLength(64)
      expect(order).toEqual(Array.from({ length: 64 }, (_, i) => i))
    })
  })

  describe('circular modules', function () {
    beforeEach(function () {
      resetModuleFnCalls()
    })

    it('should keep ESM-cycled module objects defined', function () {
      expect(usersModule).toBeDefined()
      expect(ordersModule).toBeDefined()
      expect(usersModule.needs?.()).toEqual([ordersModule])
      expect(ordersModule.needs?.()).toEqual([usersModule])
    })

    it('should load a two-module needs cycle from the users root', async function () {
      const di = new CaffeineIoC({ decorators: false, modules: [usersModule] })
      await di.init()

      expect(moduleFnCalls).toHaveLength(2)
      expect(moduleFnCalls).toContain('users')
      expect(moduleFnCalls).toContain('orders')

      const notifier = di.get(UserNotifier)
      expect(notifier.recentCount('u-1')).toBe(1)
      expect(di.get(OrderService).users).toBeInstanceOf(UserRepository)
    })

    it('should load a two-module needs cycle from the orders root', async function () {
      const di = new CaffeineIoC({ decorators: false, modules: [ordersModule] })
      await di.init()

      expect(moduleFnCalls).toHaveLength(2)
      expect(moduleFnCalls).toContain('users')
      expect(moduleFnCalls).toContain('orders')
      expect(di.get(UserNotifier).recentCount('u-1')).toBe(1)
    })

    it('should run each fn once when both cyclic modules are listed at the top level', async function () {
      const di = new CaffeineIoC({
        decorators: false,
        modules: [usersModule, ordersModule],
      })
      await di.init()

      expect(moduleFnCalls.filter(n => n === 'users')).toHaveLength(1)
      expect(moduleFnCalls.filter(n => n === 'orders')).toHaveLength(1)
      expect(di.get(UserRepository).findById('u-1').name).toBe('Ada')
    })

    it('should load a three-module needs cycle', async function () {
      const di = new CaffeineIoC({ decorators: false, modules: [catalogModule] })
      await di.init()

      expect(moduleFnCalls).toEqual(expect.arrayContaining(['catalog', 'inventory', 'pricing']))
      expect(moduleFnCalls).toHaveLength(3)
      expect(di.get(Catalog)).toBeInstanceOf(Catalog)
      expect(di.get(Inventory)).toBeInstanceOf(Inventory)
      expect(di.get(Pricing)).toBeInstanceOf(Pricing)
    })

    it('should load a three-module needs cycle from a mid-cycle root', async function () {
      const di = new CaffeineIoC({ decorators: false, modules: [inventoryModule] })
      await di.init()

      expect(moduleFnCalls).toHaveLength(3)
      expect(di.get(Catalog)).toBeInstanceOf(Catalog)
      expect(di.get(Inventory)).toBeInstanceOf(Inventory)
      expect(di.get(Pricing)).toBeInstanceOf(Pricing)
    })

    it('should load a nested provides cycle', async function () {
      const di = new CaffeineIoC({ decorators: false, modules: [alphaModule] })
      await di.init()

      expect(moduleFnCalls).toHaveLength(2)
      expect(moduleFnCalls).toContain('alpha')
      expect(moduleFnCalls).toContain('beta')
      expect(di.get(token<any>('alpha'))).toBe('alpha')
      expect(di.get(token<any>('beta'))).toBe('beta')
    })

    it('should load a nested provides cycle from the other root', async function () {
      const di = new CaffeineIoC({ decorators: false, modules: [betaModule] })
      await di.init()

      expect(moduleFnCalls).toHaveLength(2)
      expect(di.get(token<any>('alpha'))).toBe('alpha')
      expect(di.get(token<any>('beta'))).toBe('beta')
    })
  })
})
