import '../index.nodejs.js'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { Inject } from '../decorators/inject.js'
import { Injectable } from '../decorators/injectable.js'
import { UseAsyncFactory } from '../decorators/use_async_factory.js'
import { DiCaf } from '../container.js'
import { ErrInvalidBinding, ErrNoResolutionForKey } from '../errors.js'
import { useValue } from '../injection.js'
import { Provider } from '../provider.js'
import { Scopes } from '../scope.js'

describe('Manual Binding', function () {
  describe('general bindings', function () {
    abstract class Abs {
      abstract msg(): string
    }

    class Impl extends Abs {
      msg(): string {
        return 'impl'
      }
    }

    class Late {
      readonly id: string = randomUUID()

      test() {
        return 'hi'
      }
    }

    class StrValue {
      constructor(readonly val: string) {}
    }

    const sy = Symbol('test')

    class FromFactory {
      constructor(readonly val: string) {}
    }

    it('should bind to class', async function () {
      const di = new DiCaf()
      const before = di.has(Late)

      di.bind(Late)
        .toClass(Late)
        .lifetime(Scopes.SINGLETON)
      await di.init()

      const after = di.has(Late)
      const late = di.get(Late)

      expect(before)
        .toBeFalsy()
      expect(after)
        .toBeTruthy()
      expect(late)
        .toBeDefined()
    })

    it('should bind to class by name', async function () {
      const di = new DiCaf()

      di.bind('test')
        .toClass(Late)
      await di.init()

      const r = di.get<Late>('test')

      expect(r)
        .toBeInstanceOf(Late)
      expect(r.test())
        .toEqual('hi')
    })

    it('should bind abstract class to concrete implementation', async function () {
      const di = new DiCaf()

      di.bind(Abs)
        .toClass(Impl)
        .lifetime(Scopes.SINGLETON)
      await di.init()

      const impl = di.get(Abs)

      expect(impl.msg())
        .toEqual('impl')
    })

    it('should bind value', async function () {
      const di = new DiCaf()

      di.bind('val')
        .toValue('test')
      di.bind(StrValue)
        .toSelf(['val'])
      await di.init()

      const r = di.get(StrValue)
      const v = di.get('val')

      expect(r.val)
        .toEqual('test')
      expect(v)
        .toEqual('test')
    })

    it('should bind factory', async function () {
      const di = new DiCaf()

      di.bind('val')
        .toValue('test')
      di.bind(sy)
        .toFactory(({ container }) => `factory-${container.get('val')}`)
      di.bind(FromFactory)
        .toSelf([sy])
      await di.init()

      const r = di.get(FromFactory)
      const v = di.get(sy)

      expect(r.val)
        .toEqual('factory-test')
      expect(v)
        .toEqual('factory-test')
    })

    describe('toClass() with injections', function () {
      class DepA {
        readonly val = 'a'
      }

      class DepB {
        readonly val = 'b'
      }

      class TwoParam {
        constructor(
          readonly a: DepA,
          readonly b: DepB,
        ) {}
      }

      class OneParam {
        constructor(readonly a: DepA) {}
      }

      it('should resolve when multiple injections are provided', async function () {
        const di = new DiCaf()

        di.bind(DepA)
          .toSelf()
        di.bind(DepB)
          .toSelf()
        di.bind(TwoParam)
          .toClass(TwoParam, [DepA, DepB])
        await di.init()

        const svc = di.get(TwoParam)

        expect(svc.a)
          .toBeInstanceOf(DepA)
        expect(svc.b)
          .toBeInstanceOf(DepB)
      })

      it('should resolve when a single injection is provided without wrapping array', async function () {
        const di = new DiCaf()

        di.bind(DepA)
          .toSelf()
        di.bind(OneParam)
          .toClass(OneParam, [DepA])
        await di.init()

        const svc = di.get(OneParam)

        expect(svc.a)
          .toBeInstanceOf(DepA)
      })

      it('should accept an InjectionDescriptor', async function () {
        const di = new DiCaf()

        di.bind(DepA)
          .toSelf()
        di.bind(OneParam)
          .toClass(OneParam, [{ key: DepA }])
        await di.init()

        const svc = di.get(OneParam)

        expect(svc.a)
          .toBeInstanceOf(DepA)
      })
    })

    describe('toSelf() with injections', function () {
      class DepC {
        readonly val = 'c'
      }

      class DepD {
        readonly val = 'd'
      }

      class TwoParamSelf {
        constructor(
          readonly c: DepC,
          readonly d: DepD,
        ) {}
      }

      class OneParamSelf {
        constructor(readonly c: DepC) {}
      }

      it('should resolve when multiple injections are provided', async function () {
        const di = new DiCaf()

        di.bind(DepC)
          .toSelf()
        di.bind(DepD)
          .toSelf()
        di.bind(TwoParamSelf)
          .toSelf([DepC, DepD])
        await di.init()

        const svc = di.get(TwoParamSelf)

        expect(svc.c)
          .toBeInstanceOf(DepC)
        expect(svc.d)
          .toBeInstanceOf(DepD)
      })

      it('should resolve when a single injection is provided without wrapping array', async function () {
        const di = new DiCaf()

        di.bind(DepC)
          .toSelf()
        di.bind(OneParamSelf)
          .toSelf([DepC])
        await di.init()

        const svc = di.get(OneParamSelf)

        expect(svc.c)
          .toBeInstanceOf(DepC)
      })
    })

    describe('with options', function () {
      it('should bind dependency as transient when using .transient()', async function () {
        const di = new DiCaf()

        di.bind(Late)
          .toSelf()
          .lifetime(Scopes.TRANSIENT)
        await di.init()

        const r1 = di.get(Late)
        const r2 = di.get(Late)

        expect(r1.id).not.toEqual(r2.id)
      })
    })

    describe('rebinding', function () {
      it('should apply the new factory after rebind', async function () {
        const di = new DiCaf()

        di.bind(Late)
          .toSelf()
        di.rebind(Late)
          .toFactory(() => new Late())
        await di.init()

        const dep = di.get(Late)

        expect(dep)
          .toBeInstanceOf(Late)
      })

      it('should not be overwritten by a pending conditional binding on the same key', async function () {
        @Injectable()
        @ConditionalOn(() => true)
        class Original {}

        class Replacement {}

        const di = new DiCaf()
        di.rebind(Original).toClass(Replacement)
        await di.init()

        expect(di.get(Original)).toBeInstanceOf(Replacement)
      })
    })

    describe('binding several functions to the same qualifier', function () {
      const kQry = Symbol('queries')

      const kQry1 = Symbol('qry1')
      const kQry2 = Symbol('qry2')
      const kQry3 = Symbol('qry3')
      const qry1 = () => 'one'
      const qry2 = () => 'two'
      const qry3 = () => 'three'
      const qry4 = () => 'four'

      it('should resolve all functions', async function () {
        const di = new DiCaf()

        di.bind(kQry1)
          .toValue(qry1)
          .names(kQry)
        di.bind(kQry2)
          .toValue(qry2)
          .names(kQry)
        di.bind(kQry3)
          .toValue(qry3)
          .names(kQry)
        await di.init()

        const queries = di.getMany(kQry)

        expect(queries)
          .toHaveLength(3)
        expect(queries)
          .toContain(qry1)
        expect(queries)
          .toContain(qry2)
        expect(queries)
          .toContain(qry3)
        expect(queries).not.toContain(qry4)
      })
    })

    describe('binding to a custom factory', function () {
      class Dep {
        value!: string
      }

      it('should use the custom factory to build the instance', async function () {
        const di = new DiCaf()

        di.bind(Dep)
          .toFactory(() => {
            const instance = new Dep()
            instance.value = 'test'
            return instance
          })
        await di.init()

        const dep = di.get(Dep)

        expect(dep)
          .toBeInstanceOf(Dep)
        expect(dep.value)
          .toEqual('test')
      })
    })

    describe('scoping', function () {
      class TransientDep {
        readonly id: string = randomUUID()
      }

      class CtxDep {
        readonly id: string = randomUUID()
      }

      class ContainerDep {
        readonly id: string = randomUUID()
      }

      class ReqDep {}

      class RefreshDep {}

      it('should bind component as transient scoped', async function () {
        const di = new DiCaf()

        di.bind(TransientDep)
          .toSelf()
          .lifetime(Scopes.TRANSIENT)
        await di.init()

        const one = di.get(TransientDep)
        const two = di.get(TransientDep)

        expect(one).not.toEqual(two)
      })

      it('should bind component as request scoped', async function () {
        const di = new DiCaf()
        di.bind(ReqDep)
          .toSelf()
          .lifetime(Scopes.REQUEST)

        await di.init()

        expect(di.getBindings(ReqDep)[0].scopeId)
          .toEqual(Scopes.REQUEST)
      })

      it('should bind component as refresh scoped', function () {
        const di = new DiCaf()

        di.bind(RefreshDep)
          .toSelf()
          .lifetime(Scopes.REFRESH)

        expect(di.getBindings(RefreshDep)[0].scopeId)
          .toEqual(Scopes.REFRESH)
      })
    })
  })

  describe('invalid bindings scenarios', function () {
    it('should only accept self binding with class types', function () {
      const di = new DiCaf()
      expect(() => di.bind('test')
        .toSelf())
        .toThrow(ErrInvalidBinding)
    })

    it('should only accept previously registered scopes', function () {
      const di = new DiCaf()
      expect(() => di.bind('test')
        .toValue('value')
        .lifetime('nonexistent-scope'))
        .toThrow(ErrInvalidBinding)
    })

    describe('toClass() injection count mismatch', function () {
      class Dep {}

      class TwoParam {
        constructor(
          readonly a: Dep,
          readonly b: Dep,
        ) {}
      }

      it('should throw when fewer injections than constructor parameters are provided', function () {
        const di = new DiCaf()
        expect(() => di.bind(TwoParam)
          .toClass(TwoParam, [Dep]))
          .toThrow(ErrInvalidBinding)
      })

      it('should throw when more injections than constructor parameters are provided', function () {
        const di = new DiCaf()
        expect(() => di.bind(TwoParam)
          .toClass(TwoParam, [Dep, Dep, Dep]))
          .toThrow(ErrInvalidBinding)
      })
    })

    describe('toSelf() injection count mismatch', function () {
      class Dep {}

      class TwoParam {
        constructor(
          readonly a: Dep,
          readonly b: Dep,
        ) {}
      }

      it('should throw when the injection count does not match the constructor parameter count', function () {
        const di = new DiCaf()
        expect(() => di.bind(TwoParam)
          .toSelf([Dep]))
          .toThrow(ErrInvalidBinding)
      })
    })
  })

  describe('labels()', function () {
    it('should add a single label to the binding', function () {
      const kSvc = Symbol('svc')
      const di = new DiCaf()

      di.bind('svc')
        .toValue({})
        .labels(kSvc)

      expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(kSvc)))
        .toHaveLength(1)
    })

    it('should accumulate labels across multiple labels() calls', function () {
      const kA = Symbol('a')
      const kB = Symbol('b')
      const di = new DiCaf()

      di.bind('svc')
        .toValue({})
        .labels(kA)
        .labels(kB)

      expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(kA)))
        .toHaveLength(1)
      expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(kB)))
        .toHaveLength(1)
    })

    it('should not add duplicate entries when called twice with the same symbol', function () {
      const kSvc = Symbol('svc')
      const di = new DiCaf()

      di.bind('svc')
        .toValue({})
        .labels(kSvc)
        .labels(kSvc)

      const binding = di.getBindings('svc')[0]

      expect(binding.labels.filter(l => l === kSvc))
        .toHaveLength(1)
    })

    it('should add multiple labels from an array', function () {
      const kA = Symbol('a')
      const kB = Symbol('b')
      const di = new DiCaf()

      di.bind('svc')
        .toValue({})
        .labels(kA, kB)

      expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(kA)))
        .toHaveLength(1)
      expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(kB)))
        .toHaveLength(1)
    })

    it('should merge labels from single and array calls', function () {
      const kA = Symbol('a')
      const kB = Symbol('b')
      const di = new DiCaf()

      di.bind('svc')
        .toValue({})
        .labels(kA)
        .labels(kB)

      expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(kA)))
        .toHaveLength(1)
      expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(kB)))
        .toHaveLength(1)
    })

    it('should deduplicate symbols present in both existing labels and the new array', function () {
      const kSvc = Symbol('svc')
      const di = new DiCaf()

      di.bind('svc')
        .toValue({})
        .labels(kSvc)
        .labels(kSvc)

      const binding = di.getBindings('svc')[0]

      expect(binding.labels.filter(l => l === kSvc))
        .toHaveLength(1)
    })
  })

  describe('names()', function () {
    it('should deduplicate names when the same name is added twice', function () {
      const di = new DiCaf({ decorators: false })

      di.bind('svc')
        .toValue('ok')
        .names('alpha', 'alpha')

      expect(di.getBinding('svc').names)
        .toEqual(['alpha'])
    })
  })

  describe('primary()', function () {
    it('should set the primary flag on the binding', function () {
      const di = new DiCaf({ decorators: false })

      class Svc {}

      di.bind(Svc)
        .toSelf()
        .primary()

      expect(di.getBinding(Svc).primary)
        .toBe(true)
    })
  })

  describe('tags()', function () {
    it('should set a single tag on the binding', function () {
      const kRoute = Symbol('route')
      const di = new DiCaf()

      di.bind('svc')
        .toValue({})
        .tags(kRoute, '/users')

      const binding = di.getBindings('svc')[0]

      expect(binding.tags.get(kRoute))
        .toBe('/users')
    })

    it('should accumulate tags across multiple tags() calls', function () {
      const kA = Symbol('a')
      const kB = Symbol('b')
      const di = new DiCaf()

      di.bind('svc')
        .toValue({})
        .tags(kA, 1)
        .tags(kB, 2)

      const binding = di.getBindings('svc')[0]

      expect(binding.tags.get(kA))
        .toBe(1)
      expect(binding.tags.get(kB))
        .toBe(2)
    })

    it('should overwrite an existing tag when called with the same key', function () {
      const kSlot = Symbol('slot')
      const di = new DiCaf()

      di.bind('svc')
        .toValue({})
        .tags(kSlot, 'first')
        .tags(kSlot, 'second')

      const binding = di.getBindings('svc')[0]

      expect(binding.tags.get(kSlot))
        .toBe('second')
    })

    it('should set multiple tags from a map', function () {
      const kA = Symbol('a')
      const kB = Symbol('b')
      const di = new DiCaf()

      di.bind('svc')
        .toValue({})
        .tags(
          new Map([
            [kA, 'alpha'],
            [kB, 'beta'],
          ]),
        )

      const binding = di.getBindings('svc')[0]

      expect(binding.tags.get(kA))
        .toBe('alpha')
      expect(binding.tags.get(kB))
        .toBe('beta')
    })

    it('should merge single tag with map tags', function () {
      const kA = Symbol('a')
      const kB = Symbol('b')
      const di = new DiCaf()

      di.bind('svc')
        .toValue({})
        .tags(kA, 'from-single')
        .tags(new Map([[kB, 'from-map']]))

      const binding = di.getBindings('svc')[0]

      expect(binding.tags.get(kA))
        .toBe('from-single')
      expect(binding.tags.get(kB))
        .toBe('from-map')
    })

    it('should overwrite keys already present when maps overlap', function () {
      const kSlot = Symbol('slot')
      const di = new DiCaf()

      di.bind('svc')
        .toValue({})
        .tags(kSlot, 'first')
        .tags(new Map([[kSlot, 'second']]))

      const binding = di.getBindings('svc')[0]

      expect(binding.tags.get(kSlot))
        .toBe('second')
    })
  })

  describe('postConstruct()', function () {
    it('should call the specified method after the instance is resolved', async function () {
      const spy = vi.fn()

      class SvcWithInit {
        init() {
          spy()
        }
      }

      const di = new DiCaf()
      di.bind(SvcWithInit)
        .toSelf()
        .postConstruct(v => v.init())
      await di.init()
      di.get(SvcWithInit)

      expect(spy)
        .toHaveBeenCalledTimes(1)
    })

    it('should not call the method on subsequent resolutions of a singleton', async function () {
      const spy = vi.fn()

      class SvcWithInit {
        init() {
          spy()
        }
      }

      const di = new DiCaf()
      di.bind(SvcWithInit)
        .toSelf()
        .postConstruct(v => v.init())
      await di.init()
      di.get(SvcWithInit)
      di.get(SvcWithInit)

      expect(spy)
        .toHaveBeenCalledTimes(1)
    })
  })

  describe('lazy', function () {
    const lazySpy = vi.fn()
    const nonLazySpy = vi.fn()

    class Laziest {
      constructor() {
        lazySpy()
      }
    }

    class NonLazy {
      constructor() {
        nonLazySpy()
      }
    }

    it('should not init component on bootstrap when it is configured as lazy', async function () {
      const di = new DiCaf()

      di.bind(Laziest)
        .toSelf()
        .lazy()
      di.bind(NonLazy)
        .toSelf()
        .lazy(false)
      await di.init()

      expect(lazySpy).not.toHaveBeenCalled()
      expect(nonLazySpy)
        .toHaveBeenCalled()
    })
  })

  describe('async binding constraints', function () {
    it('should throw ErrInvalidBinding when async binding has an injectable property', function () {
      const kDep = Symbol('dep')

      @UseAsyncFactory(async () => new AsyncWithInjectableProp())
      @Injectable()
      class AsyncWithInjectableProp {
        @Inject(kDep)
        dep!: unknown
      }

      void AsyncWithInjectableProp

      expect(() => new DiCaf())
        .toThrow(ErrInvalidBinding)
    })

    it('should throw ErrInvalidBinding when async binding has an injectable method', function () {
      const kDep = Symbol('dep')

      @UseAsyncFactory(async () => new AsyncWithInjectableMethod())
      @Injectable()
      class AsyncWithInjectableMethod {
        dep!: unknown

        @Inject([kDep])
        setDep(dep: unknown) {
          this.dep = dep
        }
      }

      void AsyncWithInjectableMethod

      expect(() => new DiCaf())
        .toThrow(ErrInvalidBinding)
    })
  })

  describe('useValue()', function () {
    it('should inject a string constant', async function () {
      class StringParam {
        constructor(readonly val: string) {}
      }

      const di = new DiCaf({ decorators: false })
      di.bind(StringParam)
        .toSelf([useValue('hello')])
      await di.init()

      expect(di.get(StringParam).val)
        .toEqual('hello')
    })

    it('should inject a numeric constant', async function () {
      class NumParam {
        constructor(readonly val: number) {}
      }

      const di = new DiCaf({ decorators: false })
      di.bind(NumParam)
        .toSelf([useValue(42)])
      await di.init()

      expect(di.get(NumParam).val)
        .toEqual(42)
    })

    it('should inject an object by reference', async function () {
      const config = { host: 'localhost', port: 3000 }
      type Config = typeof config

      class ConfigConsumer {
        constructor(readonly config: Config) {}
      }

      const di = new DiCaf({ decorators: false })
      di.bind(ConfigConsumer)
        .toSelf([useValue(config)])
      await di.init()

      expect(di.get(ConfigConsumer).config)
        .toBe(config)
    })

    it('should inject null', async function () {
      class NullParam {
        constructor(readonly val: unknown) {}
      }

      const di = new DiCaf({ decorators: false })
      di.bind(NullParam)
        .toSelf([useValue(null)])
      await di.init()

      expect(di.get(NullParam).val)
        .toBeNull()
    })

    it('should inject undefined', async function () {
      class UndefinedParam {
        constructor(readonly val: unknown) {}
      }

      const di = new DiCaf({ decorators: false })
      di.bind(UndefinedParam)
        .toSelf([useValue(undefined)])
      await di.init()

      expect(di.get(UndefinedParam).val)
        .toBeUndefined()
    })

    it('should inject multiple constants', async function () {
      class MultiParam {
        constructor(
          readonly host: string,
          readonly port: number,
        ) {}
      }

      const di = new DiCaf({ decorators: false })
      di.bind(MultiParam)
        .toSelf([useValue('localhost'), useValue(3000)])
      await di.init()

      expect(di.get(MultiParam).host)
        .toEqual('localhost')
      expect(di.get(MultiParam).port)
        .toEqual(3000)
    })
  })

  describe('aliasOf()', function () {
    it('should resolve alias to value target', async function () {
      const di = new DiCaf({ decorators: false })
      const key1 = Symbol('key1')
      const key2 = Symbol('key2')

      di.bind(key2).toValue('hello')
      di.bind(key1).aliasOf(key2)
      await di.init()

      expect(di.get(key1)).toEqual('hello')
      expect(di.get(key1)).toEqual(di.get(key2))
    })

    it('should resolve alias to class target', async function () {
      class Svc {}

      const key = Symbol('alias')
      const di = new DiCaf({ decorators: false })

      di.bind(Svc).toSelf()
      di.bind(key).aliasOf(Svc)
      await di.init()

      expect(di.get(key)).toBeInstanceOf(Svc)
    })

    it('should share the same singleton instance via both keys', async function () {
      class Svc {
        readonly id = Math.random()
      }

      const alias = Symbol('alias')
      const di = new DiCaf({ decorators: false })

      di.bind(Svc).toSelf()
        .lifetime(Scopes.SINGLETON)
      di.bind(alias).aliasOf(Svc)
      await di.init()

      expect(di.get(alias)).toBe(di.get(Svc))
    })

    it('should resolve when alias is registered before the target', async function () {
      class Svc {}

      const alias = Symbol('alias')
      const di = new DiCaf({ decorators: false })

      di.bind(alias).aliasOf(Svc)
      di.bind(Svc).toSelf()
        .lifetime(Scopes.SINGLETON)
      await di.init()

      expect(di.get(alias)).toBe(di.get(Svc))
    })

    it('should support additional names on the alias', async function () {
      const key2 = Symbol('key2')
      const di = new DiCaf({ decorators: false })

      di.bind(key2).toValue(42)
      di.bind(Symbol('key1')).aliasOf(key2)
        .names('named-alias')
      await di.init()

      expect(di.get<number>('named-alias')).toEqual(42)
    })

    it('should throw ErrNoResolutionForKey when target is not registered', async function () {
      class Unregistered {}

      const alias = Symbol('alias')
      const di = new DiCaf({ decorators: false })

      di.bind(alias).aliasOf(Unregistered)

      await expect(di.init()).rejects.toThrow(ErrNoResolutionForKey)
    })
  })

  describe('method injection count', function () {
    const kDep = Symbol('dep')

    it('should throw when fewer injection keys are specified than required method parameters', async function () {
      @Injectable()
      class OneInjectionTwoMethodParams {
        val!: unknown

        @Inject([kDep])
        setVal(_a: unknown, _b: unknown) {
          this.val = _a
        }
      }

      void OneInjectionTwoMethodParams

      expect(() => new DiCaf())
        .toThrow()
    })
  })
})

describe('wrap()', function () {
  it('should return a Provider that resolves the binding on each get()', async function () {
    const di = new DiCaf({ decorators: false })
    di.bind('svc').toValue({ name: 'service' })
    await di.init()

    const provider: Provider<{ name: string }> = di.wrap('svc')

    expect(provider.get()).toEqual({ name: 'service' })
    expect(provider.get()).toBe(provider.get())
  })

  it('should throw ErrNoResolutionForKey when key is not registered', function () {
    const di = new DiCaf({ decorators: false })

    expect(() => di.wrap('nonexistent')).toThrow(ErrNoResolutionForKey)
  })
})

describe('wrapMany()', function () {
  it('should return a Provider<T[]> resolving all bindings for a shared name key', async function () {
    const kSvc = Symbol('wrap-many-svc')

    const di = new DiCaf({ decorators: false })
    di.bind('alpha').toValue('alpha')
      .names(kSvc)
    di.bind('bravo').toValue('bravo')
      .names(kSvc)
    await di.init()

    const provider: Provider<string[]> = di.wrapMany(kSvc)
    const results = provider.get()

    expect(results).toHaveLength(2)
    expect(results).toContain('alpha')
    expect(results).toContain('bravo')
  })

  it('should throw ErrNoResolutionForKey when no bindings exist for the key', function () {
    const di = new DiCaf({ decorators: false })
    const kMissing = Symbol('wrap-many-missing')

    expect(() => di.wrapMany(kMissing)).toThrow(ErrNoResolutionForKey)
  })
})
