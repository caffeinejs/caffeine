import { describe, it, expect } from 'vitest'
import { CaffeineIoC } from '../container.js'
import { Module, mod } from '../module.js'
import { ContainerBindingOps } from '../container_interface.js'
import { ErrInvalidContainerState } from '../errors.js'

class Svc {
  value = 'from-module'
}

class OtherSvc {
  value = 'other'
}

describe('Module', function () {
  describe('new CaffeineIoC(...modules)', function () {
    it('should accept modules as the first parameter without options', async function () {
      const mod: Module = (container: ContainerBindingOps) => {
        container.bind(Svc)
          .toSelf()
      }

      const di = new CaffeineIoC({ decorators: false }, mod)
      await di.init()

      expect(di.get(Svc))
        .toBeInstanceOf(Svc)
    })

    it('should accept multiple modules without options', async function () {
      const modA: Module = (container: ContainerBindingOps) => {
        container.bind(Svc)
          .toSelf()
      }
      const modB: Module = (container: ContainerBindingOps) => {
        container.bind(OtherSvc)
          .toSelf()
      }

      const di = new CaffeineIoC({ decorators: false }, modA, modB)
      await di.init()

      expect(di.get(Svc))
        .toBeInstanceOf(Svc)
      expect(di.get(OtherSvc))
        .toBeInstanceOf(OtherSvc)
    })
  })

  describe('new CaffeineIoC(options, ...modules)', function () {
    it('should execute a single module and register its bindings', async function () {
      const mod: Module = (container: ContainerBindingOps) => {
        container.bind(Svc)
          .toSelf()
      }

      const di = new CaffeineIoC({ decorators: false }, mod)
      await di.init()

      expect(di.get(Svc))
        .toBeInstanceOf(Svc)
    })

    it('should execute multiple modules in order', async function () {
      const order: number[] = []

      const mod1: Module = () => {
        order.push(1)
      }
      const mod2: Module = () => {
        order.push(2)
      }
      const mod3: Module = () => {
        order.push(3)
      }

      const di = new CaffeineIoC({ decorators: false }, mod1, mod2, mod3)
      await di.init()

      expect(order)
        .toEqual([1, 2, 3])
    })

    it('should give each module access to the container', async function () {
      const mod: Module = (container: ContainerBindingOps) => {
        container.bind('key')
          .toValue('value')
      }

      const di = new CaffeineIoC({ decorators: false }, mod)
      await di.init()

      expect(di.get('key'))
        .toBe('value')
    })

    it('should execute modules during init', async function () {
      let moduleCalled = false

      const module: Module = () => {
        moduleCalled = true
      }

      const di = new CaffeineIoC({ decorators: false }, module)
      await di.init()

      expect(moduleCalled)
        .toBe(true)
    })

    it('should support multiple modules each registering different bindings', async function () {
      const modA: Module = (container: ContainerBindingOps) => {
        container.bind(Svc)
          .toSelf()
      }
      const modB: Module = (container: ContainerBindingOps) => {
        container.bind(OtherSvc)
          .toSelf()
      }

      const di = new CaffeineIoC({ decorators: false }, modA, modB)
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
  })

  describe('new CaffeineIoC(...modules)', function () {
    it('should accept modules as the first parameter without options', async function () {
      const mod: Module = (container: ContainerBindingOps) => {
        container.bind('key')
          .toValue('value')
      }

      const di = new CaffeineIoC(mod)
      await di.init()

      expect(di.get('key'))
        .toBe('value')
    })

    it('should accept multiple modules without options', async function () {
      const modA: Module = (container: ContainerBindingOps) => {
        container.bind(Svc)
          .toSelf()
      }
      const modB: Module = (container: ContainerBindingOps) => {
        container.bind(OtherSvc)
          .toSelf()
      }

      const di = new CaffeineIoC(modA, modB)
      await di.init()

      expect(di.get(Svc))
        .toBeInstanceOf(Svc)
      expect(di.get(OtherSvc))
        .toBeInstanceOf(OtherSvc)
    })
  })

  describe('new CaffeineIoC(options, ...modules)', function () {
    it('should execute modules after autoWire', async function () {
      const mod: Module = (container: ContainerBindingOps) => {
        container.bind('manual-key')
          .toValue('manual-value')
      }

      const di = new CaffeineIoC({}, mod)
      await di.init()

      expect(di.get('manual-key'))
        .toBe('manual-value')
    })

    it('should execute multiple modules in order after autoWire', async function () {
      const order: number[] = []

      const mod1: Module = () => {
        order.push(1)
      }
      const mod2: Module = () => {
        order.push(2)
      }

      const di = new CaffeineIoC({}, mod1, mod2)
      await di.init()

      expect(order)
        .toEqual([1, 2])
    })

    it('should work with no modules', async function () {
      const di = new CaffeineIoC()
      await expect(di.init()).resolves.toBeUndefined()
    })

    it('should coexist with auto-wired bindings', async function () {
      const kToken = Symbol('module-test-token')
      const module: Module = (container: ContainerBindingOps) => {
        container.bind(kToken)
          .toValue(42)
      }

      const di = new CaffeineIoC({}, module)
      await di.init()

      expect(di.get(kToken))
        .toBe(42)
    })
  })

  describe('addModules', function () {
    it('should register a module queued before init', async function () {
      const module: Module = (container: ContainerBindingOps) => {
        container.bind(Svc).toSelf()
      }

      const di = new CaffeineIoC({ decorators: false })
      di.addModules(module)
      await di.init()

      expect(di.get(Svc)).toBeInstanceOf(Svc)
    })

    it('should register multiple modules queued before init', async function () {
      const modA: Module = (container: ContainerBindingOps) => {
        container.bind(Svc).toSelf()
      }
      const modB: Module = (container: ContainerBindingOps) => {
        container.bind(OtherSvc).toSelf()
      }

      const di = new CaffeineIoC({ decorators: false })
      di.addModules(modA, modB)
      await di.init()

      expect(di.get(Svc)).toBeInstanceOf(Svc)
      expect(di.get(OtherSvc)).toBeInstanceOf(OtherSvc)
    })

    it('should execute modules added via addModules after constructor modules', async function () {
      const order: number[] = []

      const ctorMod: Module = () => {
        order.push(1)
      }
      const addedMod: Module = () => {
        order.push(2)
      }

      const di = new CaffeineIoC({ decorators: false }, ctorMod)
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

      const module: Module = () =>
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

      const module: Module = () =>
        new Promise<void>(resolve => {
          setTimeout(() => {
            resolved = true
            resolve()
          }, 0)
        })

      const di = new CaffeineIoC({ decorators: false }, module)
      await di.init()

      expect(resolved)
        .toBe(true)
    })
  })

  describe('module hooks', function () {
    it('should emit onModuleRegistered after a successful module', async function () {
      const events: { name: string, index: number }[] = []

      const module: Module = () => {}

      const di = new CaffeineIoC({ decorators: false }, module)
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

      const di = new CaffeineIoC({ decorators: false }, module)
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

      const di = new CaffeineIoC({ decorators: false }, mod1, mod2, mod3)
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

      const module: Module = () => Promise.reject(error)

      const di = new CaffeineIoC({ decorators: false }, module)
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

      const di = new CaffeineIoC({ decorators: false }, module)
      di.hooks.on('onModuleRegistrationFailed', e => failures.push(e))

      await expect(di.init()).rejects.toThrow(error)

      expect(failures[0])
        .toMatchObject({ name: 'FailingModule', index: 0, error })
    })

    it('should not emit onModuleRegistered when module rejects', async function () {
      const registered: unknown[] = []

      const module: Module = () => Promise.reject(new Error('boom'))

      const di = new CaffeineIoC({ decorators: false }, module)
      di.hooks.on('onModuleRegistered', e => registered.push(e))

      await expect(di.init()).rejects.toThrow()

      expect(registered)
        .toHaveLength(0)
    })

    it('should emit onModuleRegistrationFailed when module throws synchronously', async function () {
      const error = new Error('sync failure')
      const failures: { name: string, index: number, error: Error }[] = []

      const module: Module = () => {
        throw error
      }

      const di = new CaffeineIoC({ decorators: false }, module)
      di.hooks.on('onModuleRegistrationFailed', e => failures.push(e))

      await expect(di.init()).rejects.toThrow(error)

      expect(failures)
        .toHaveLength(1)
      expect(failures[0])
        .toMatchObject({ index: 0, error })
    })

    it('should not emit onModuleRegistered when module throws synchronously', async function () {
      const registered: unknown[] = []

      const module: Module = () => {
        throw new Error('sync boom')
      }

      const di = new CaffeineIoC({ decorators: false }, module)
      di.hooks.on('onModuleRegistered', e => registered.push(e))

      await expect(di.init()).rejects.toThrow()

      expect(registered)
        .toHaveLength(0)
    })
  })
})
