import '../index.nodejs.js'
import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { token } from '../key.js'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { Inject } from '../decorators/inject.js'
import { Injectable } from '../decorators/injectable.js'
import { UseAsyncFactory } from '../decorators/use_async_factory.js'
import { CaffeineIoC } from '../container.js'
import { ErrInvalidBinding, ErrNoResolutionForKey } from '../errors.js'
import { $i } from '../injection.js'
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

    const sy = token<any>(Symbol('test'))

    class FromFactory {
      constructor(readonly val: string) {}
    }

    it('should bind to class', async function () {
      const di = new CaffeineIoC()
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
      const di = new CaffeineIoC()

      di.bind(token<any>('test'))
        .toClass(Late)
      await di.init()

      const r = di.get<Late>(token<any>('test'))

      expect(r)
        .toBeInstanceOf(Late)
      expect(r.test())
        .toEqual('hi')
    })

    it('should bind abstract class to concrete implementation', async function () {
      const di = new CaffeineIoC()

      di.bind(Abs)
        .toClass(Impl)
        .lifetime(Scopes.SINGLETON)
      await di.init()

      const impl = di.get(Abs)

      expect(impl.msg())
        .toEqual('impl')
    })

    it('should bind value', async function () {
      const di = new CaffeineIoC()

      di.bind(token<any>('val'))
        .toValue('test')
      di.bind(StrValue)
        .toSelf([token<any>('val')])
      await di.init()

      const r = di.get(StrValue)
      const v = di.get(token<any>('val'))

      expect(r.val)
        .toEqual('test')
      expect(v)
        .toEqual('test')
    })

    it('should bind factory', async function () {
      const di = new CaffeineIoC()

      di.bind(token<any>('val'))
        .toValue('test')
      di.bind(sy)
        .toFactory(({ container }) => `factory-${container.get(token<any>('val'))}`)
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
        const di = new CaffeineIoC()

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
        const di = new CaffeineIoC()

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
        const di = new CaffeineIoC()

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
        const di = new CaffeineIoC()

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
        const di = new CaffeineIoC()

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
        const di = new CaffeineIoC()

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
        const di = new CaffeineIoC()

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

        const di = new CaffeineIoC()
        di.rebind(Original).toClass(Replacement)
        await di.init()

        expect(di.get(Original)).toBeInstanceOf(Replacement)
      })
    })

    describe('binding several functions to the same qualifier', function () {
      const kQry = token<any>(Symbol('queries'))

      const kQry1 = token<any>(Symbol('qry1'))
      const kQry2 = token<any>(Symbol('qry2'))
      const kQry3 = token<any>(Symbol('qry3'))
      const qry1 = () => 'one'
      const qry2 = () => 'two'
      const qry3 = () => 'three'
      const qry4 = () => 'four'

      it('should resolve all functions', async function () {
        const di = new CaffeineIoC()

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
        const di = new CaffeineIoC()

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
        const di = new CaffeineIoC()

        di.bind(TransientDep)
          .toSelf()
          .lifetime(Scopes.TRANSIENT)
        await di.init()

        const one = di.get(TransientDep)
        const two = di.get(TransientDep)

        expect(one).not.toEqual(two)
      })

      it('should bind component as request scoped', async function () {
        const di = new CaffeineIoC()
        di.bind(ReqDep)
          .toSelf()
          .lifetime(Scopes.REQUEST)

        await di.init()

        expect(di.getBindings(ReqDep)[0].scopeID)
          .toEqual(Scopes.REQUEST)
      })

      it('should bind component as refresh scoped', function () {
        const di = new CaffeineIoC()

        di.bind(RefreshDep)
          .toSelf()
          .lifetime(Scopes.REFRESH)

        expect(di.getBindings(RefreshDep)[0].scopeID)
          .toEqual(Scopes.REFRESH)
      })
    })
  })

  describe('invalid bindings scenarios', function () {
    it('should only accept self binding with class types', function () {
      const di = new CaffeineIoC()
      expect(() => di.bind(token<any>('test'))
        .toSelf())
        .toThrow(ErrInvalidBinding)
    })

    it('should only accept previously registered scopes', function () {
      const di = new CaffeineIoC()
      expect(() => di.bind(token<any>('test'))
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
        const di = new CaffeineIoC()
        expect(() => di.bind(TwoParam)
          .toClass(TwoParam, [Dep]))
          .toThrow(ErrInvalidBinding)
      })

      it('should throw when more injections than constructor parameters are provided', function () {
        const di = new CaffeineIoC()
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
        const di = new CaffeineIoC()
        expect(() => di.bind(TwoParam)
          .toSelf([Dep]))
          .toThrow(ErrInvalidBinding)
      })
    })
  })

  describe('labels()', function () {
    it('should add a single label to the binding', function () {
      const kSvc = token<any>(Symbol('svc'))
      const di = new CaffeineIoC()

      di.bind(token<any>('svc'))
        .toValue({})
        .labels(kSvc)

      expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(kSvc)))
        .toHaveLength(1)
    })

    it('should accumulate labels across multiple labels() calls', function () {
      const kA = token<any>(Symbol('a'))
      const kB = token<any>(Symbol('b'))
      const di = new CaffeineIoC()

      di.bind(token<any>('svc'))
        .toValue({})
        .labels(kA)
        .labels(kB)

      expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(kA)))
        .toHaveLength(1)
      expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(kB)))
        .toHaveLength(1)
    })

    it('should not add duplicate entries when called twice with the same symbol', function () {
      const kSvc = token<any>(Symbol('svc'))
      const di = new CaffeineIoC()

      di.bind(token<any>('svc'))
        .toValue({})
        .labels(kSvc)
        .labels(kSvc)

      const binding = di.getBindings(token<any>('svc'))[0]

      expect(binding.labels.filter(l => l === kSvc))
        .toHaveLength(1)
    })

    it('should add multiple labels from an array', function () {
      const kA = token<any>(Symbol('a'))
      const kB = token<any>(Symbol('b'))
      const di = new CaffeineIoC()

      di.bind(token<any>('svc'))
        .toValue({})
        .labels(kA, kB)

      expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(kA)))
        .toHaveLength(1)
      expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(kB)))
        .toHaveLength(1)
    })

    it('should merge labels from single and array calls', function () {
      const kA = token<any>(Symbol('a'))
      const kB = token<any>(Symbol('b'))
      const di = new CaffeineIoC()

      di.bind(token<any>('svc'))
        .toValue({})
        .labels(kA)
        .labels(kB)

      expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(kA)))
        .toHaveLength(1)
      expect(di.getBindingsBy(descriptor => descriptor.binding.labels.includes(kB)))
        .toHaveLength(1)
    })

    it('should deduplicate symbols present in both existing labels and the new array', function () {
      const kSvc = token<any>(Symbol('svc'))
      const di = new CaffeineIoC()

      di.bind(token<any>('svc'))
        .toValue({})
        .labels(kSvc)
        .labels(kSvc)

      const binding = di.getBindings(token<any>('svc'))[0]

      expect(binding.labels.filter(l => l === kSvc))
        .toHaveLength(1)
    })
  })

  describe('names()', function () {
    it('should deduplicate names when the same name is added twice', function () {
      const di = new CaffeineIoC({ decorators: false })

      di.bind(token<any>('svc'))
        .toValue('ok')
        .names('alpha', 'alpha')

      expect(di.getBinding(token<any>('svc')).names)
        .toEqual(['alpha'])
    })
  })

  describe('primary()', function () {
    it('should set the primary flag on the binding', function () {
      const di = new CaffeineIoC({ decorators: false })

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
      const kRoute = token<any>(Symbol('route'))
      const di = new CaffeineIoC()

      di.bind(token<any>('svc'))
        .toValue({})
        .tags(kRoute, '/users')

      const binding = di.getBindings(token<any>('svc'))[0]

      expect(binding.tags.get(kRoute))
        .toBe('/users')
    })

    it('should accumulate tags across multiple tags() calls', function () {
      const kA = token<any>(Symbol('a'))
      const kB = token<any>(Symbol('b'))
      const di = new CaffeineIoC()

      di.bind(token<any>('svc'))
        .toValue({})
        .tags(kA, 1)
        .tags(kB, 2)

      const binding = di.getBindings(token<any>('svc'))[0]

      expect(binding.tags.get(kA))
        .toBe(1)
      expect(binding.tags.get(kB))
        .toBe(2)
    })

    it('should overwrite an existing tag when called with the same key', function () {
      const kSlot = token<any>(Symbol('slot'))
      const di = new CaffeineIoC()

      di.bind(token<any>('svc'))
        .toValue({})
        .tags(kSlot, 'first')
        .tags(kSlot, 'second')

      const binding = di.getBindings(token<any>('svc'))[0]

      expect(binding.tags.get(kSlot))
        .toBe('second')
    })

    it('should set multiple tags from a map', function () {
      const kA = token<any>(Symbol('a'))
      const kB = token<any>(Symbol('b'))
      const di = new CaffeineIoC()

      di.bind(token<any>('svc'))
        .toValue({})
        .tags(
          new Map([
            [kA, 'alpha'],
            [kB, 'beta'],
          ]),
        )

      const binding = di.getBindings(token<any>('svc'))[0]

      expect(binding.tags.get(kA))
        .toBe('alpha')
      expect(binding.tags.get(kB))
        .toBe('beta')
    })

    it('should merge single tag with map tags', function () {
      const kA = token<any>(Symbol('a'))
      const kB = token<any>(Symbol('b'))
      const di = new CaffeineIoC()

      di.bind(token<any>('svc'))
        .toValue({})
        .tags(kA, 'from-single')
        .tags(new Map([[kB, 'from-map']]))

      const binding = di.getBindings(token<any>('svc'))[0]

      expect(binding.tags.get(kA))
        .toBe('from-single')
      expect(binding.tags.get(kB))
        .toBe('from-map')
    })

    it('should overwrite keys already present when maps overlap', function () {
      const kSlot = token<any>(Symbol('slot'))
      const di = new CaffeineIoC()

      di.bind(token<any>('svc'))
        .toValue({})
        .tags(kSlot, 'first')
        .tags(new Map([[kSlot, 'second']]))

      const binding = di.getBindings(token<any>('svc'))[0]

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

      const di = new CaffeineIoC()
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

      const di = new CaffeineIoC()
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
      const di = new CaffeineIoC()

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
      const kDep = token<any>(Symbol('dep'))

      @UseAsyncFactory(async () => new AsyncWithInjectableProp())
      @Injectable()
      class AsyncWithInjectableProp {
        @Inject(kDep)
        dep!: unknown
      }

      void AsyncWithInjectableProp

      expect(() => new CaffeineIoC())
        .toThrow(ErrInvalidBinding)
    })

    it('should throw ErrInvalidBinding when async binding has an injectable method', function () {
      const kDep = token<any>(Symbol('dep'))

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

      expect(() => new CaffeineIoC())
        .toThrow(ErrInvalidBinding)
    })
  })

  describe('$i.just()', function () {
    it('should inject a string constant', async function () {
      class StringParam {
        constructor(readonly val: string) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(StringParam)
        .toSelf([$i.just('hello')])
      await di.init()

      expect(di.get(StringParam).val)
        .toEqual('hello')
    })

    it('should inject a numeric constant', async function () {
      class NumParam {
        constructor(readonly val: number) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(NumParam)
        .toSelf([$i.just(42)])
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

      const di = new CaffeineIoC({ decorators: false })
      di.bind(ConfigConsumer)
        .toSelf([$i.just(config)])
      await di.init()

      expect(di.get(ConfigConsumer).config)
        .toBe(config)
    })

    it('should inject null', async function () {
      class NullParam {
        constructor(readonly val: unknown) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(NullParam)
        .toSelf([$i.just(null)])
      await di.init()

      expect(di.get(NullParam).val)
        .toBeNull()
    })

    it('should inject undefined', async function () {
      class UndefinedParam {
        constructor(readonly val: unknown) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(UndefinedParam)
        .toSelf([$i.just(undefined)])
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

      const di = new CaffeineIoC({ decorators: false })
      di.bind(MultiParam)
        .toSelf([$i.just('localhost'), $i.just(3000)])
      await di.init()

      expect(di.get(MultiParam).host)
        .toEqual('localhost')
      expect(di.get(MultiParam).port)
        .toEqual(3000)
    })
  })

  describe('aliasOf()', function () {
    it('should resolve alias to value target', async function () {
      const di = new CaffeineIoC({ decorators: false })
      const key1 = token<any>(Symbol('key1'))
      const key2 = token<any>(Symbol('key2'))

      di.bind(key2).toValue('hello')
      di.bind(key1).aliasOf(key2)
      await di.init()

      expect(di.get(key1)).toEqual('hello')
      expect(di.get(key1)).toEqual(di.get(key2))
    })

    it('should resolve alias to class target', async function () {
      class Svc {}

      const key = token<any>(Symbol('alias'))
      const di = new CaffeineIoC({ decorators: false })

      di.bind(Svc).toSelf()
      di.bind(key).aliasOf(Svc)
      await di.init()

      expect(di.get(key)).toBeInstanceOf(Svc)
    })

    it('should share the same singleton instance via both keys', async function () {
      class Svc {
        readonly id = Math.random()
      }

      const alias = token<any>(Symbol('alias'))
      const di = new CaffeineIoC({ decorators: false })

      di.bind(Svc).toSelf()
        .lifetime(Scopes.SINGLETON)
      di.bind(alias).aliasOf(Svc)
      await di.init()

      expect(di.get(alias)).toBe(di.get(Svc))
    })

    it('should resolve when alias is registered before the target', async function () {
      class Svc {}

      const alias = token<any>(Symbol('alias'))
      const di = new CaffeineIoC({ decorators: false })

      di.bind(alias).aliasOf(Svc)
      di.bind(Svc).toSelf()
        .lifetime(Scopes.SINGLETON)
      await di.init()

      expect(di.get(alias)).toBe(di.get(Svc))
    })

    it('should support additional names on the alias', async function () {
      const key2 = token<any>(Symbol('key2'))
      const di = new CaffeineIoC({ decorators: false })

      di.bind(key2).toValue(42)
      di.bind(token<any>(Symbol('key1'))).aliasOf(key2)
        .names('named-alias')
      await di.init()

      expect(di.get(token<number>('named-alias'))).toEqual(42)
    })

    it('should throw ErrNoResolutionForKey when target is not registered', async function () {
      class Unregistered {}

      const alias = token<any>(Symbol('alias'))
      const di = new CaffeineIoC({ decorators: false })

      di.bind(alias).aliasOf(Unregistered)

      await expect(di.init()).rejects.toThrow(ErrNoResolutionForKey)
    })
  })

  describe('method injection count', function () {
    const kDep = token<any>(Symbol('dep'))

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

      expect(() => new CaffeineIoC())
        .toThrow()
    })
  })
})

describe('wrap()', function () {
  it('should return a Provider that resolves the binding on each get()', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(token<any>('svc')).toValue({ name: 'service' })
    await di.init()

    const provider: Provider<{ name: string }> = di.wrap(token<any>('svc'))

    expect(provider.get()).toEqual({ name: 'service' })
    expect(provider.get()).toBe(provider.get())
  })

  it('should throw ErrNoResolutionForKey when key is not registered', function () {
    const di = new CaffeineIoC({ decorators: false })

    expect(() => di.wrap(token<any>('nonexistent'))).toThrow(ErrNoResolutionForKey)
  })
})

describe('wrapMany()', function () {
  it('should return a Provider<T[]> resolving all bindings for a shared name key', async function () {
    const kSvc = token<any>(Symbol('wrap-many-svc'))

    const di = new CaffeineIoC({ decorators: false })
    di.bind(token<any>('alpha')).toValue('alpha')
      .names(kSvc)
    di.bind(token<any>('bravo')).toValue('bravo')
      .names(kSvc)
    await di.init()

    const provider: Provider<string[]> = di.wrapMany(kSvc)
    const results = provider.get()

    expect(results).toHaveLength(2)
    expect(results).toContain('alpha')
    expect(results).toContain('bravo')
  })

  it('should throw ErrNoResolutionForKey when no bindings exist for the key', function () {
    const di = new CaffeineIoC({ decorators: false })
    const kMissing = token<any>(Symbol('wrap-many-missing'))

    expect(() => di.wrapMany(kMissing)).toThrow(ErrNoResolutionForKey)
  })

  it('should return a Provider<T[]> with one element for a single binding (fast path)', async function () {
    const kSingle = token<any>(Symbol('wrap-many-single'))

    const di = new CaffeineIoC({ decorators: false })
    di.bind(token<any>('solo')).toValue('only-one')
      .names(kSingle)
    await di.init()

    const provider: Provider<string[]> = di.wrapMany(kSingle)

    expect(provider.get()).toEqual(['only-one'])
    expect(provider.get()).toHaveLength(1)
  })
})

describe('wrapBinding()', function () {
  it('should return a Provider that resolves the binding on each get()', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(token<any>('svc')).toValue({ name: 'service' })
    await di.init()

    const binding = di.getBinding<{ name: string }>(token<any>('svc'))
    const provider: Provider<{ name: string }> = di.wrapBinding(binding)

    expect(provider.get()).toEqual({ name: 'service' })
    expect(provider.get()).toBe(provider.get())
  })

  it('should return a new instance on each get() for a transient binding', async function () {
    class Dep {}

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Dep).toSelf()
      .lifetime(Scopes.TRANSIENT)
    await di.init()

    const binding = di.getBinding(Dep)
    const provider: Provider<Dep> = di.wrapBinding(binding)

    expect(provider.get()).toBeInstanceOf(Dep)
    expect(provider.get()).not.toBe(provider.get())
  })
})

describe('wrapBindings()', function () {
  it('should return a Provider<T[]> wrapping a single binding (fast path)', async function () {
    const di = new CaffeineIoC({ decorators: false })
    di.bind(token<any>('solo')).toValue('only-one')
    await di.init()

    const bindings = di.getBindings<string>(token<any>('solo'))
    const provider: Provider<string[]> = di.wrapBindings(bindings)

    expect(provider.get()).toEqual(['only-one'])
  })

  it('should return a Provider<T[]> resolving all bindings (loop path)', async function () {
    const kShared = token<any>(Symbol('wrap-bindings-shared'))

    const di = new CaffeineIoC({ decorators: false })
    di.bind(token<any>('alpha')).toValue('alpha')
      .names(kShared)
    di.bind(token<any>('bravo')).toValue('bravo')
      .names(kShared)
    await di.init()

    const bindings = di.getBindings<string>(kShared)
    const provider: Provider<string[]> = di.wrapBindings(bindings)
    const results = provider.get()

    expect(results).toHaveLength(2)
    expect(results).toContain('alpha')
    expect(results).toContain('bravo')
  })
})
