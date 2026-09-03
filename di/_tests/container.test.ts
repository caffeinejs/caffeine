import { randomUUID } from 'node:crypto'

import { describe, it, expect, vi, beforeEach } from 'vitest'

import { Binding } from '../binding.js'
import { CaffeineIoC } from '../container.js'
import { ContainerBindingOps } from '../container_interface.js'
import { Configuration } from '../decorators/configuration.js'
import { Inject } from '../decorators/inject.js'
import { Injectable } from '../decorators/injectable.js'
import { Named } from '../decorators/named.js'
import { PreDestroy } from '../decorators/pre_destroy.js'
import { Primary } from '../decorators/primary.js'
import { Profile } from '../decorators/profile.js'
import { Provides } from '../decorators/provides.js'
import { ErrInvalidContainerState, ErrUnresolvableDependencies } from '../errors.js'
import { Factory } from '../factory.js'
import { $i } from '../injection.js'
import { SingletonScope } from '../internal/core/scope/singleton.js'
import { token } from '../key.js'
import { ResolutionContext as Ctx } from '../resolution_context.js'
import { bindScope, unbindScope, type Scope } from '../scope.js'

describe('Scope removal does not affect existing containers', function () {
  it('should successfully dispose even when the scope factory is removed from the registry after container creation', async function () {
    const kCustom = token<Scope>(Symbol('custom-scope-destroy'))

    bindScope(kCustom, () => new SingletonScope())

    const di = new CaffeineIoC({ decorators: false })

    @Injectable()
    class Destroyable {
      @PreDestroy()
      destroy() {}
    }

    di.bind(Destroyable, t => t.toSelf().lifetime(kCustom))
    await di.init()
    di.get(Destroyable)

    unbindScope(kCustom)

    await expect(di.dispose()).resolves.toBeUndefined()
  })
})

describe('bind() — registration', function () {
  it('should register the key immediately when bind() is called with a complete spec', function () {
    const di = new CaffeineIoC({ decorators: false })

    class Svc {}

    expect(di.has(Svc)).toBe(false)

    di.bind(Svc, t => t.toSelf())

    expect(di.has(Svc)).toBe(true)
  })

  it('should not register a key without an explicit bind() call', function () {
    const di = new CaffeineIoC({ decorators: false })

    expect(di.getBindings(token<Record<string, unknown>>('my-key'))).toHaveLength(0)
  })
})

describe('Container Operations', function () {
  describe('resetting', function () {
    describe('sync', function () {
      const kValue = token<string>(Symbol('test_reset_value'))

      class Dep1 {
        readonly id: string = randomUUID()

        constructor(readonly value: string) {}
      }

      @Injectable()
      class Dep2 {
        readonly id: string = randomUUID()
      }

      const kDep3 = token<Dep3>(Symbol('dep_3'))

      class Dep3 {
        readonly id: string = randomUUID()
      }

      @Configuration()
      class Conf {
        @Provides(kDep3)
        dep3(): Dep3 {
          return new Dep2()
        }
      }

      const kDep4 = token<Dep4>(Symbol('dep_4'))

      @Injectable(kDep4)
      class Dep4 {
        readonly id: string = randomUUID()
      }

      it('should reset all instances, keeping value providers', async function () {
        const di = new CaffeineIoC()

        di.bind(kValue, t => t.toValue('test'))
        di.bind(Dep1, t => t.toSelf([kValue]))
        await di.init()

        const dep11_1 = di.get(Dep1)
        const dep12_1 = di.get(Dep1)
        const dep21_1 = di.get(Dep2)
        const dep31_1 = di.get(kDep3)
        const dep32_1 = di.get(kDep3)
        const dep41_1 = di.get(kDep4)
        const dep42_1 = di.get(Dep4)

        await di.resetInstances().catch(() => {})

        const dep11_2 = di.get(Dep1)
        const dep22_2 = di.get(Dep2)
        const dep31_2 = di.get(kDep3)
        const dep41_2 = di.get(kDep4)

        expect(dep11_1).toEqual(dep12_1)
        expect(dep11_2).not.toEqual(dep11_1)
        expect(dep21_1).not.toEqual(dep22_2)
        expect(dep11_1.value).toEqual('test')
        expect(dep11_2.value).toEqual('test')
        expect(dep31_1).toEqual(dep32_1)
        expect(dep31_1).not.toEqual(dep31_2)
        expect(dep41_1).toEqual(dep42_1)
        expect(dep41_1).not.toEqual(dep41_2)
      })

      it('should reset only the requested instance', async function () {
        const di = new CaffeineIoC()

        di.bind(kValue, t => t.toValue('test'))
        di.bind(Dep1, t => t.toSelf([kValue]))
        await di.init()

        const dep1 = di.get(Dep1)
        const dep2 = di.get(Dep2)
        const dep3 = di.get(kDep3)
        const dep4_1 = di.get(kDep4)
        const dep4_2 = di.get(Dep4)

        expect(dep4_1).toEqual(dep4_2)

        await di.resetInstance(Dep1)
        await di.resetInstance(kDep3)
        await di.resetInstance(kDep4)

        const otherDep1 = di.get(Dep1)
        const otherDep2 = di.get(Dep2)
        const otherDep3 = di.get(kDep3)
        const otherDep4_1 = di.get(kDep4)
        const otherDep4_2 = di.get(Dep4)

        expect(otherDep4_1).toEqual(otherDep4_2)

        expect(dep1).not.toEqual(otherDep1)
        expect(dep2).toEqual(otherDep2)
        expect(dep3).not.toEqual(otherDep3)
        expect(dep4_1).not.toEqual(otherDep4_1)
        expect(dep4_2).not.toEqual(otherDep4_2)
      })
    })

    describe('async', function () {
      const kValue = token<string>(Symbol('test_reset_value_async'))
      const spy = vi.fn()

      @Injectable([kValue])
      @Profile('container-ops-async-reset')
      class Dep1 {
        readonly id: string = randomUUID()

        constructor(readonly value: string) {}

        @PreDestroy()
        destroy() {
          spy()
        }
      }

      @Injectable()
      class Dep2 {
        readonly id: string = randomUUID()
      }

      @Injectable()
      class Dep3 {
        readonly id: string = randomUUID()
      }

      it('should reset only the requested instance and call destroy hook if any', async function () {
        const di = new CaffeineIoC({ profiles: ['container-ops-async-reset'] })

        di.bind(kValue, t => t.toValue('test'))
        di.bind(Dep1, t => t.toSelf([kValue]))
        await di.init()

        const dep1 = di.get(Dep1)
        const dep2 = di.get(Dep2)
        const dep3 = di.get(Dep3)

        await di.resetInstance(Dep1)
        await di.resetInstance(Dep2)

        const otherDep1 = di.get(Dep1)
        const otherDep2 = di.get(Dep2)
        const otherDep3 = di.get(Dep3)

        expect(dep1).not.toEqual(otherDep1)
        expect(dep2).not.toEqual(otherDep2)
        expect(dep3).toEqual(otherDep3)
        expect(spy).toHaveBeenCalledTimes(1)
      })
    })

    describe('resetInstance — concurrent preDestroy', function () {
      const kShared = token<Record<string, unknown>>(Symbol('shared-predestroy-key'))
      const spyA = vi.fn()
      const spyB = vi.fn()

      beforeEach(function () {
        spyA.mockClear()
        spyB.mockClear()
      })

      @Injectable()
      @Named(kShared)
      class SharedA {
        @PreDestroy()
        destroy() {
          spyA()
          throw new Error('SharedA destroy error')
        }
      }

      @Injectable()
      @Named(kShared)
      class SharedB {
        @PreDestroy()
        destroy() {
          spyB()
        }
      }

      it('should call all preDestroy hooks even when one throws', async function () {
        const di = new CaffeineIoC()
        await di.init()

        di.get(SharedA)
        di.get(SharedB)

        await expect(di.resetInstance(kShared)).rejects.toThrow('SharedA destroy error')

        expect(spyA).toHaveBeenCalledTimes(1)
        expect(spyB).toHaveBeenCalledTimes(1)
      })
    })

    describe('resetInstance — async scope reset', function () {
      it('should await a Promise returned by scope.reset()', async function () {
        const kAsyncScope = token<Scope>(Symbol('async-reset-scope'))
        let asyncResetCompleted = false

        bindScope(kAsyncScope, () => ({
          provide<T>(_ctx: Ctx, factory: Factory<T>): T {
            return factory(_ctx)
          },
          cachedInstance<T>(_binding: Binding): T | undefined {
            return undefined
          },
          async reset(_binding: Binding): Promise<void> {
            await Promise.resolve()
            asyncResetCompleted = true
          },
          configure(_binding: Binding): void {
            //
          },
          undo(_binding: Binding): void {
            //
          },
          get lazy(): boolean {
            return false
          },
          get durable(): boolean {
            return false
          },
        }))

        @Injectable()
        class AsyncResetSvc {}

        const di = new CaffeineIoC({ decorators: false })
        di.bind(AsyncResetSvc, t => t.toSelf().lifetime(kAsyncScope))
        await di.init()
        di.get(AsyncResetSvc)

        await di.resetInstance(AsyncResetSvc)

        expect(asyncResetCompleted).toBe(true)

        unbindScope(kAsyncScope)
      })
    })
  })
})

describe('resetInstance — binding stays registered after preDestroy (H-1)', function () {
  it('should keep the binding in the registry after resetInstance with preDestroy', async function () {
    const spy = vi.fn()

    @Injectable()
    class WithDestroy {
      @PreDestroy()
      destroy() {
        spy()
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(WithDestroy, t => t.toSelf())
    await di.init()

    const before = di.get(WithDestroy)
    expect(before).toBeInstanceOf(WithDestroy)

    await di.resetInstance(WithDestroy)

    expect(spy).toHaveBeenCalledTimes(1)
    expect(di.has(WithDestroy)).toBe(true)

    const after = di.get(WithDestroy)
    expect(after).toBeInstanceOf(WithDestroy)
    expect(before).not.toBe(after)
  })
})

describe('init() idempotency (M-3)', function () {
  it('should run modules exactly once when init() is called multiple times', async function () {
    const spy = vi.fn()

    const module = (container: ContainerBindingOps) => {
      spy()
      container.bind(token<Record<string, unknown>>('svc-m3'), t => t.toValue({}))
    }

    const di = new CaffeineIoC({ decorators: false, modules: [module] })

    await di.init()
    await di.init()
    await di.init()

    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('dispose() (L-1, L-5)', function () {
  it('should set ready to false after dispose()', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(token<Record<string, unknown>>('svc-l1'), t => t.toValue({}))
    await di.init()

    expect(di.ready).toBe(true)

    await di.dispose()

    expect(di.ready).toBe(false)
  })

  it('should reject with AggregateError when multiple preDestroy hooks fail', async function () {
    @Injectable()
    class SvcA {
      @PreDestroy()
      destroy() {
        throw new Error('svc-a error')
      }
    }

    @Injectable()
    class SvcB {
      @PreDestroy()
      destroy() {
        throw new Error('svc-b error')
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(SvcA, t => t.toSelf())
    di.bind(SvcB, t => t.toSelf())
    await di.init()

    di.get(SvcA)
    di.get(SvcB)

    const err = await di.dispose().catch(e => e)

    expect(err).toBeInstanceOf(AggregateError)
    expect((err as AggregateError).errors).toHaveLength(2)
  })
})

describe('async singleton resolution timing (L-3)', function () {
  it('should resolve async singletons exactly once and return the resolved value, not a Promise', async function () {
    const kAsync = token<Record<string, unknown>>(Symbol('async-l3'))
    const spy = vi.fn()

    const di = new CaffeineIoC({ decorators: false })
    di.bind(kAsync, t =>
      t.toAsyncFactory(async () => {
        spy()
        return { value: 'resolved' }
      }),
    )
    await di.init()

    expect(spy).toHaveBeenCalledTimes(1)

    const result = di.get(kAsync)
    expect(result).toEqual({ value: 'resolved' })
    expect(result).not.toBeInstanceOf(Promise)
  })

  describe('ensure container can resolve all registered bindings', function () {
    const kArfrPropDep = token<string>(Symbol('arfr-prop-dep'))
    const kArfrMethodDep = token<Record<string, unknown>>(Symbol('arfr-method-dep'))
    const kArfrPrimaryKey = token<Record<string, unknown>>(Symbol('arfr-primary-key'))
    const kArfrPrimaryNs = 'arfr-primary-ns'

    @Injectable()
    @Profile('arfr-checks')
    class ArfrSvcWithPropInjection {
      @Inject(kArfrPropDep)
      accessor dep!: string
    }

    @Injectable()
    @Profile('arfr-checks')
    class ArfrSvcWithMethodInjection {
      @Inject([kArfrMethodDep])
      init(_dep: unknown) {}
    }

    @Injectable()
    @Named(kArfrPrimaryKey)
    @Primary()
    @Profile(kArfrPrimaryNs)
    class ArfrPrimaryImpl {}

    @Injectable()
    @Named(kArfrPrimaryKey)
    @Profile(kArfrPrimaryNs)
    class ArfrSecondaryImpl {}

    describe('assertFullyResolvable', function () {
      it('should not throw when all dependencies are resolvable', function () {
        const kDep = token<string>(Symbol('arfr-dep-1'))
        const di = new CaffeineIoC({ decorators: false })
        di.bind(kDep, t => t.toValue('value'))
        di.bind(token<Record<string, unknown>>('svc'), t => t.toFunction((_: unknown) => ({}), [kDep]))

        expect(() => di.assertResolvable()).not.toThrow()
      })

      it('should throw when a required constructor dependency is missing', function () {
        const kMissing = token<Record<string, unknown>>(Symbol('arfr-missing-ctor'))
        const di = new CaffeineIoC({ decorators: false })
        di.bind(token<Record<string, unknown>>('svc'), t => t.toFunction((_: unknown) => ({}), [kMissing]))

        let caught: ErrUnresolvableDependencies | undefined
        try {
          di.assertResolvable()
        } catch (e) {
          caught = e as ErrUnresolvableDependencies
        }

        expect(caught).toBeInstanceOf(ErrUnresolvableDependencies)
        expect(caught!.issues).toHaveLength(1)
        expect(caught!.issues[0]).toContain(kMissing.toString())
      })

      it('should not throw when an optional dependency is missing', function () {
        const kOptional = token<Record<string, unknown>>(Symbol('arfr-optional'))
        const di = new CaffeineIoC({ decorators: false })
        di.bind(token<Record<string, unknown>>('svc'), t =>
          t.toFunction((_: unknown) => ({}), [$i.optional(kOptional)]),
        )

        expect(() => di.assertResolvable()).not.toThrow()
      })

      it('should not throw when injectAll has multiple candidates', function () {
        const kShared = token<Record<string, unknown>>(Symbol('arfr-shared-multi'))
        class ImplA {}
        class ImplB {}
        const di = new CaffeineIoC({ decorators: false })
        di.bind(ImplA, t => t.toValue(new ImplA()).names(kShared))
        di.bind(ImplB, t => t.toValue(new ImplB()).names(kShared))
        di.bind(token<Record<string, unknown>>('consumer'), t =>
          t.toFunction((_: unknown) => ({}), [$i.allOf(kShared)]),
        )

        expect(() => di.assertResolvable()).not.toThrow()
      })

      it('should throw when multiple candidates exist for a non-injectAll injection', function () {
        const kShared = token<Record<string, unknown>>(Symbol('arfr-shared-ambig'))
        class ImplA {}
        class ImplB {}
        const di = new CaffeineIoC({ decorators: false })
        di.bind(ImplA, t => t.toValue(new ImplA()).names(kShared))
        di.bind(ImplB, t => t.toValue(new ImplB()).names(kShared))
        di.bind(token<Record<string, unknown>>('consumer'), t => t.toFunction((_: unknown) => ({}), [kShared]))

        let caught: ErrUnresolvableDependencies | undefined
        try {
          di.assertResolvable()
        } catch (e) {
          caught = e as ErrUnresolvableDependencies
        }

        expect(caught).toBeInstanceOf(ErrUnresolvableDependencies)
        expect(caught!.issues).toHaveLength(1)
        expect(caught!.issues[0]).toContain('Ambiguous')
      })

      it('should not throw when a primary binding disambiguates multiple candidates', async function () {
        const di = new CaffeineIoC({ profiles: [kArfrPrimaryNs] })
        di.bind(token<Record<string, unknown>>('consumer'), t => t.toFunction((_: unknown) => ({}), [kArfrPrimaryKey]))

        await di.compile()
        expect(() => di.assertResolvable()).not.toThrow()
      })

      it('should not throw when a deferred dependency is resolvable', function () {
        const kDeferred = token<string>(Symbol('arfr-deferred'))
        const di = new CaffeineIoC({ decorators: false })
        di.bind(kDeferred, t => t.toValue('val'))
        di.bind(token<Record<string, unknown>>('svc'), t =>
          t.toFunction((_: unknown) => ({}), [$i.defer(() => kDeferred)]),
        )

        expect(() => di.assertResolvable()).not.toThrow()
      })

      it('should throw when a deferred dependency is missing', function () {
        const kDeferred = token<string>(Symbol('arfr-deferred-missing'))
        const di = new CaffeineIoC({ decorators: false })
        di.bind(token<Record<string, unknown>>('svc'), t =>
          t.toFunction((_: unknown) => ({}), [$i.defer(() => kDeferred)]),
        )

        expect(() => di.assertResolvable()).toThrow(ErrUnresolvableDependencies)
      })

      it('should throw when a property injection dependency is missing', function () {
        const di = new CaffeineIoC({ decorators: false })
        di.bind(ArfrSvcWithPropInjection, t => t.toSelf())

        let caught: ErrUnresolvableDependencies | undefined
        try {
          di.assertResolvable()
        } catch (e) {
          caught = e as ErrUnresolvableDependencies
        }

        expect(caught).toBeInstanceOf(ErrUnresolvableDependencies)
        expect(caught!.issues).toHaveLength(1)
        expect(caught!.issues[0]).toContain(kArfrPropDep.toString())
      })

      it('should throw when a method injection dependency is missing', function () {
        const di = new CaffeineIoC({ decorators: false })
        di.bind(ArfrSvcWithMethodInjection, t => t.toSelf())

        let caught: ErrUnresolvableDependencies | undefined
        try {
          di.assertResolvable()
        } catch (e) {
          caught = e as ErrUnresolvableDependencies
        }

        expect(caught).toBeInstanceOf(ErrUnresolvableDependencies)
        expect(caught!.issues).toHaveLength(1)
        expect(caught!.issues[0]).toContain(kArfrMethodDep.toString())
      })

      it('should collect all issues rather than stopping at the first', function () {
        const kA = token<Record<string, unknown>>(Symbol('arfr-multi-err-a'))
        const kB = token<Record<string, unknown>>(Symbol('arfr-multi-err-b'))
        const di = new CaffeineIoC({ decorators: false })
        di.bind(token<Record<string, unknown>>('svc'), t => t.toFunction((_a: unknown, _b: unknown) => ({}), [kA, kB]))

        let caught: ErrUnresolvableDependencies | undefined
        try {
          di.assertResolvable()
        } catch (e) {
          caught = e as ErrUnresolvableDependencies
        }

        expect(caught).toBeInstanceOf(ErrUnresolvableDependencies)
        expect(caught!.issues).toHaveLength(2)
      })

      it('should resolve dependencies from a parent container', function () {
        const kDep = token<string>(Symbol('arfr-parent-dep'))
        const parent = new CaffeineIoC({ decorators: false })
        parent.bind(kDep, t => t.toValue('from-parent'))

        const child = parent.newChild()
        child.bind(token<Record<string, unknown>>('svc'), t => t.toFunction((_: unknown) => ({}), [kDep]))

        expect(() => child.assertResolvable()).not.toThrow()
      })
    })
  })
})

describe('CaffeineIoC constructor — modules via options', function () {
  it('should accept a module function on Options.modules', async function () {
    const di = new CaffeineIoC({
      modules: [
        (container: ContainerBindingOps) => {
          container.bind(token<string>('greeting'), t => t.toValue('hello'))
        },
      ],
    })
    await di.init()

    expect(di.get(token<Record<string, unknown>>('greeting'))).toBe('hello')
  })
})

describe('get() / getOptional() / getMany() before init()', function () {
  it('get() throws ErrInvalidContainerState before init()', function () {
    const di = new CaffeineIoC({ decorators: false })
    expect(() => di.get(token<Record<string, unknown>>('k'))).toThrow(ErrInvalidContainerState)
  })

  it('getOptional() throws ErrInvalidContainerState before init()', function () {
    const di = new CaffeineIoC({ decorators: false })

    expect(() => di.getOptional(token<Record<string, unknown>>('k'))).toThrow(ErrInvalidContainerState)
  })

  it('getMany() throws ErrInvalidContainerState before init()', function () {
    const di = new CaffeineIoC({ decorators: false })
    expect(() => di.getMany(token<Record<string, unknown>>('k'))).toThrow(ErrInvalidContainerState)
  })
})
