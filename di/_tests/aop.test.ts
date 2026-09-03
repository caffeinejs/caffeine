import { describe, it, expect, vi, beforeAll } from 'vitest'
import { token } from '../key.js'
import { CaffeineIoC } from '../container.js'
import { Inject } from '../decorators/inject.js'
import { Aspect } from '../decorators/aspect.js'
import { Injectable } from '../decorators/injectable.js'
import { Label } from '../decorators/label.js'
import { Profile } from '../decorators/profile.js'
import { Order } from '../decorators/order.js'
import { Tag } from '../decorators/tag.js'
import { $aop } from '../aop.js'
import type { JoinPoint, MethodAspect } from '../aop.js'
import { createAnnotation } from '../annotations.js'
import { reflect } from '../reflect.js'
import { Lifetime } from '../decorators/lifetime.js'
import { ErrInvalidAspect, ErrInvalidContainerState, ErrInvalidDecorator } from '../errors.js'
import { $i } from '../injection.js'
import type { Provider } from '../provider.js'
import { Scopes } from '../scope.js'

class Calculator {
  add(a: number, b: number): number { return a + b }
  fail(): never { throw new Error('boom') }
}

describe('AOP', function () {
  describe('before hook', function () {
    const beforeSpy = vi.fn()

    @Aspect([$aop.forClass(Calculator, 'add')])
    @Profile('aop-before')
    class BeforeAspect implements MethodAspect<Calculator> {
      before(jp: JoinPoint<Calculator>) {
        beforeSpy([...jp.args])
        jp.args = [10, 20]
      }
    }
    void BeforeAspect

    it('should run before the method and can modify args', async function () {
      beforeSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-before'] })
      di.bind(Calculator, t => t.toSelf())
      await di.init()

      const result = di.get(Calculator).add(1, 2)

      expect(beforeSpy).toHaveBeenCalledOnce()
      expect(beforeSpy).toHaveBeenCalledWith([1, 2])
      expect(result).toBe(30)
    })
  })

  describe('pointcut builder function', function () {
    const beforeSpy = vi.fn()

    @Aspect(p => [p.forClass(Calculator, 'add')])
    @Profile('aop-builder-fn')
    class BuilderFnAspect implements MethodAspect<Calculator> {
      before(jp: JoinPoint<Calculator>) {
        beforeSpy([...jp.args])
      }
    }
    void BuilderFnAspect

    it('should resolve pointcuts from a builder function receiving $aop', async function () {
      beforeSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-builder-fn'] })
      di.bind(Calculator, t => t.toSelf())
      await di.init()

      const result = di.get(Calculator).add(1, 2)

      expect(beforeSpy).toHaveBeenCalledOnce()
      expect(beforeSpy).toHaveBeenCalledWith([1, 2])
      expect(result).toBe(3)
    })
  })

  describe('afterReturn hook', function () {
    @Aspect([$aop.forClass(Calculator, 'add')])
    @Profile('aop-after-return')
    class AfterReturnAspect implements MethodAspect<Calculator> {
      afterReturn(_jp: JoinPoint<Calculator>, result: unknown) {
        return (result as number) * 2
      }
    }
    void AfterReturnAspect

    it('should transform the return value', async function () {
      const di = new CaffeineIoC({ profiles: ['aop-after-return'] })
      di.bind(Calculator, t => t.toSelf())
      await di.init()

      expect(di.get(Calculator).add(3, 4)).toBe(14)
    })
  })

  describe('afterThrow hook', function () {
    @Aspect([$aop.forClass(Calculator, 'fail')])
    @Profile('aop-swallow')
    class SwallowAspect implements MethodAspect<Calculator> {
      afterThrow() { /* swallow */ }
    }
    void SwallowAspect

    @Aspect([$aop.forClass(Calculator, 'fail')])
    @Profile('aop-propagate')
    class NoopBeforeAspect implements MethodAspect<Calculator> {
      before() { /* noop */ }
    }
    void NoopBeforeAspect

    it('should intercept and swallow a thrown error', async function () {
      const di = new CaffeineIoC({ profiles: ['aop-swallow'] })
      di.bind(Calculator, t => t.toSelf())
      await di.init()

      expect(() => di.get(Calculator).fail()).not.toThrow()
    })

    it('should propagate the error when afterThrow is not defined', async function () {
      const di = new CaffeineIoC({ profiles: ['aop-propagate'] })
      di.bind(Calculator, t => t.toSelf())
      await di.init()

      expect(() => di.get(Calculator).fail()).toThrow('boom')
    })
  })

  describe('after hook', function () {
    const afterSuccessSpy = vi.fn()

    @Aspect([$aop.forClass(Calculator, 'add')])
    @Profile('aop-after-success')
    class AfterSuccessAspect implements MethodAspect<Calculator> {
      after(_jp: JoinPoint<Calculator>, result: unknown, error: Error | undefined) {
        afterSuccessSpy(result, error)
      }
    }
    void AfterSuccessAspect

    const afterFailureSpy = vi.fn()

    @Aspect([$aop.forClass(Calculator, 'fail')])
    @Profile('aop-after-failure')
    class AfterFailureAspect implements MethodAspect<Calculator> {
      afterThrow() { /* swallow so after() still runs */ }
      after(_jp: JoinPoint<Calculator>, result: unknown, error: Error | undefined) {
        afterFailureSpy(result, error)
      }
    }
    void AfterFailureAspect

    it('should run after successful execution with result and no error', async function () {
      afterSuccessSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-after-success'] })
      di.bind(Calculator, t => t.toSelf())
      await di.init()

      di.get(Calculator).add(1, 2)

      expect(afterSuccessSpy).toHaveBeenCalledOnce()
      expect(afterSuccessSpy).toHaveBeenCalledWith(3, undefined)
    })

    it('should run after a thrown error, receiving the error', async function () {
      afterFailureSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-after-failure'] })
      di.bind(Calculator, t => t.toSelf())
      await di.init()

      di.get(Calculator).fail()

      expect(afterFailureSpy).toHaveBeenCalledOnce()
      const [result, error] = afterFailureSpy.mock.calls[0] as [unknown, Error]
      expect(result).toBeUndefined()
      expect(error).toBeInstanceOf(Error)
    })
  })

  describe('around hook', function () {
    const greetSpy = vi.fn()

    class Greeter {
      greet(): string { return greetSpy() }
    }

    @Aspect([$aop.forClass(Greeter, 'greet')])
    @Profile('aop-short-circuit')
    class ShortCircuitAspect implements MethodAspect<Greeter> {
      around() { return 'intercepted' }
    }
    void ShortCircuitAspect

    @Aspect([$aop.forClass(Calculator, 'add')])
    @Profile('aop-around-proceed')
    class AroundProceedAspect implements MethodAspect<Calculator> {
      around(jp: JoinPoint<Calculator>) {
        return (jp.proceed(...jp.args) as number) + 100
      }
    }
    void AroundProceedAspect

    it('should short-circuit and skip the original method', async function () {
      greetSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-short-circuit'] })
      di.bind(Greeter, t => t.toSelf())
      await di.init()

      const result = di.get(Greeter).greet()

      expect(result).toBe('intercepted')
      expect(greetSpy).not.toHaveBeenCalled()
    })

    it('should call the original via proceed() and wrap the result', async function () {
      const di = new CaffeineIoC({ profiles: ['aop-around-proceed'] })
      di.bind(Calculator, t => t.toSelf())
      await di.init()

      expect(di.get(Calculator).add(1, 2)).toBe(103)
    })
  })

  describe('priority', function () {
    class Svc {
      run(): void { /* intentionally empty */ }
    }

    const priorityOrder: string[] = []

    @Order(1)
    @Aspect([$aop.forClass(Svc, 'run')])
    @Profile('aop-priority')
    class OuterAspect implements MethodAspect<Svc> {
      before() { priorityOrder.push('outer-before') }
      after() { priorityOrder.push('outer-after') }
    }
    void OuterAspect

    @Order(10)
    @Aspect([$aop.forClass(Svc, 'run')])
    @Profile('aop-priority')
    class InnerAspect implements MethodAspect<Svc> {
      before() { priorityOrder.push('inner-before') }
      after() { priorityOrder.push('inner-after') }
    }
    void InnerAspect

    it('should execute in onion order — lower order is outermost', async function () {
      priorityOrder.length = 0

      const di = new CaffeineIoC({ profiles: ['aop-priority'] })
      di.bind(Svc, t => t.toSelf())
      await di.init()

      di.get(Svc).run()

      expect(priorityOrder).toEqual([
        'outer-before',
        'inner-before',
        'inner-after',
        'outer-after',
      ])
    })
  })

  describe('method targeting', function () {
    class MultiMethod {
      foo() { return 'foo' }
      bar() { return 'bar' }
    }

    class AllMethods {
      alpha() { return 'a' }
      beta() { return 'b' }
    }

    const methodListSpy = vi.fn()

    @Aspect([$aop.forClass(MultiMethod, 'foo')])
    @Profile('aop-method-list')
    class FooOnlyAspect implements MethodAspect<MultiMethod> {
      before(jp: JoinPoint<MultiMethod>) { methodListSpy(jp.methodName) }
    }
    void FooOnlyAspect

    const allMethodsSpy = vi.fn()

    @Aspect([$aop.forClass(AllMethods)])
    @Profile('aop-all-methods')
    class AllMethodsAspect implements MethodAspect<AllMethods> {
      before(jp: JoinPoint<AllMethods>) { allMethodsSpy(jp.methodName) }
    }
    void AllMethodsAspect

    it('should intercept only listed methods', async function () {
      methodListSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-method-list'] })
      di.bind(MultiMethod, t => t.toSelf())
      await di.init()

      const svc = di.get(MultiMethod)
      svc.foo()
      svc.bar()

      expect(methodListSpy).toHaveBeenCalledOnce()
      expect(methodListSpy).toHaveBeenCalledWith('foo')
    })

    it('should intercept all methods when no method list is given', async function () {
      allMethodsSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-all-methods'] })
      di.bind(AllMethods, t => t.toSelf())
      await di.init()

      const svc = di.get(AllMethods)
      svc.alpha()
      svc.beta()

      expect(allMethodsSpy).toHaveBeenCalledTimes(2)
      expect(allMethodsSpy.mock.calls.map(([m]) => m).sort()).toEqual(['alpha', 'beta'])
    })
  })

  describe('injected dependency', function () {
    class Target {
      work() { return 42 }
    }

    const kLogPrefix = token<any>(Symbol('log-prefix'))
    const logged: string[] = []

    @Aspect([$aop.forClass(Target, 'work')])
    @Profile('aop-inject')
    class LoggingAspect implements MethodAspect<Target> {
      @Inject(kLogPrefix)
      prefix!: string

      before(jp: JoinPoint<Target>) {
        logged.push(`${this.prefix}:${String(jp.methodName)}`)
      }
    }
    void LoggingAspect

    it('should resolve aspect field dependencies from the container', async function () {
      logged.length = 0

      const di = new CaffeineIoC({ profiles: ['aop-inject'] })
      di.bind(kLogPrefix, t => t.toValue('[LOG]'))
      di.bind(Target, t => t.toSelf())
      await di.init()

      di.get(Target).work()

      expect(logged).toEqual(['[LOG]:work'])
    })
  })

  describe('async method', function () {
    class AsyncTarget {
      async fetch(id: number): Promise<string> { return `item-${id}` }
    }

    const asyncBeforeSpy = vi.fn()

    @Aspect([$aop.forClass(AsyncTarget, 'fetch')])
    @Profile('aop-async')
    class AsyncAspect implements MethodAspect<AsyncTarget> {
      async before(jp: JoinPoint<AsyncTarget>) {
        asyncBeforeSpy(jp.args[0])
      }

      async around(jp: JoinPoint<AsyncTarget>) {
        const result = await jp.proceed(...jp.args)
        return `${result}!`
      }
    }
    void AsyncAspect

    it('should work with async before and async around hooks', async function () {
      asyncBeforeSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-async'] })
      di.bind(AsyncTarget, t => t.toSelf())
      await di.init()

      const result = await di.get(AsyncTarget).fetch(7)

      expect(asyncBeforeSpy).toHaveBeenCalledWith(7)
      expect(result).toBe('item-7!')
    })
  })

  describe('constructor deps', function () {
    const kGreetSvc = token<any>(Symbol('greet-svc'))

    class GreetSvc {
      msg() { return 'hello-from-svc' }
    }

    class InjTarget {
      work() { return 'done' }
    }

    const ctorInjSpy = vi.fn()
    const injFirstSpy = vi.fn()

    @Aspect([$aop.forClass(InjTarget, 'work')], [kGreetSvc])
    @Profile('aop-ctor-inject')
    class CtorInjAspect implements MethodAspect<InjTarget> {
      constructor(private svc: GreetSvc) {}
      before() { ctorInjSpy(this.svc.msg()) }
    }
    void CtorInjAspect

    @Aspect([$aop.forClass(InjTarget, 'work')], [kGreetSvc])
    @Profile('aop-injectable-first')
    class InjFirstAspect implements MethodAspect<InjTarget> {
      constructor(private svc: GreetSvc) {}
      before() { injFirstSpy(this.svc.msg()) }
    }
    void InjFirstAspect

    it('should inject constructor deps declared in @Aspect', async function () {
      ctorInjSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-ctor-inject'] })
      di.bind(kGreetSvc, t => t.toClass(GreetSvc))
      di.bind(InjTarget, t => t.toSelf())
      await di.init()

      di.get(InjTarget).work()

      expect(ctorInjSpy).toHaveBeenCalledOnce()
      expect(ctorInjSpy).toHaveBeenCalledWith('hello-from-svc')
    })

    it('should inject constructor deps declared in @Aspect regardless of decorator ordering', async function () {
      injFirstSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-injectable-first'] })
      di.bind(kGreetSvc, t => t.toClass(GreetSvc))
      di.bind(InjTarget, t => t.toSelf())
      await di.init()

      di.get(InjTarget).work()

      expect(injFirstSpy).toHaveBeenCalledOnce()
      expect(injFirstSpy).toHaveBeenCalledWith('hello-from-svc')
    })
  })

  describe('method predicate', function () {
    const Transactional = createAnnotation<true>()

    @Injectable()
    class TxTarget {
      @Transactional(true)
      save() { return 'saved' }

      query() { return 'queried' }
    }

    const txPredSpy = vi.fn()

    @Aspect([$aop.forClass(TxTarget, (name, _desc, cls) => reflect.get(cls, Transactional, name) !== undefined)])
    @Profile('aop-method-pred')
    class TxAspect implements MethodAspect<TxTarget> {
      before(jp: JoinPoint<TxTarget>) { txPredSpy(jp.methodName) }
    }
    void TxAspect

    @Injectable()
    class MultiTagTarget {
      @Transactional(true)
      alpha() { return 'a' }

      @Transactional(true)
      beta() { return 'b' }

      gamma() { return 'c' }
    }

    const multiTagSpy = vi.fn()

    const multiTagPred = (name: string | symbol, _d: any, cls: any) =>
      reflect.get(cls, Transactional, name) !== undefined
    @Aspect([$aop.forClass(MultiTagTarget, multiTagPred)])
    @Profile('aop-multi-tag')
    class MultiTagAspect implements MethodAspect<MultiTagTarget> {
      before(jp: JoinPoint<MultiTagTarget>) { multiTagSpy(jp.methodName) }
    }
    void MultiTagAspect

    const CacheAnnotation = createAnnotation<{ ttl: number }>()

    @Injectable()
    class CacheTarget {
      @CacheAnnotation({ ttl: 60 })
      fetch() { return 'data' }

      noop() { return 'noop' }
    }

    const cacheSpy = vi.fn()

    @Aspect([$aop.forClass(CacheTarget, (name, _desc, cls) => reflect.get(cls, CacheAnnotation, name) !== undefined)])
    @Profile('aop-method-cache')
    class MethodCacheAspect implements MethodAspect<CacheTarget> {
      around(jp: JoinPoint<CacheTarget>) {
        const opts = reflect.get(jp.ctor, CacheAnnotation, jp.methodName)!
        cacheSpy(opts.ttl)
        return jp.proceed(...jp.args)
      }
    }
    void MethodCacheAspect

    const SvcLogAnnotation = createAnnotation<{ prefix: string }>()

    @SvcLogAnnotation({ prefix: 'REPORT' })
    @Injectable()
    class ReportSvc {
      generate() { return 'report' }
    }

    const classAnnSpy = vi.fn()

    @Aspect([$aop.pointcut((_desc, cls) => reflect.get(cls, SvcLogAnnotation) !== undefined)])
    @Profile('aop-class-ann')
    class ClassAnnAspect implements MethodAspect {
      around(jp: JoinPoint) {
        const opts = reflect.get(jp.ctor, SvcLogAnnotation)!
        classAnnSpy(opts.prefix)
        return jp.proceed(...jp.args)
      }
    }
    void ClassAnnAspect

    it('should intercept only methods matching the annotation predicate', async function () {
      txPredSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-method-pred'] })
      di.bind(TxTarget, t => t.toSelf())
      await di.init()

      const svc = di.get(TxTarget)
      svc.save()
      svc.query()

      expect(txPredSpy).toHaveBeenCalledOnce()
      expect(txPredSpy).toHaveBeenCalledWith('save')
    })

    it('should intercept all annotated methods when multiple methods carry the annotation', async function () {
      multiTagSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-multi-tag'] })
      di.bind(MultiTagTarget, t => t.toSelf())
      await di.init()

      const svc = di.get(MultiTagTarget)
      svc.alpha()
      svc.beta()
      svc.gamma()

      expect(multiTagSpy).toHaveBeenCalledTimes(2)
      expect(multiTagSpy.mock.calls.map(([m]) => m).sort()).toEqual(['alpha', 'beta'])
    })

    it('should expose method-level annotation via jp.annotations inside around hook', async function () {
      cacheSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-method-cache'] })
      di.bind(CacheTarget, t => t.toSelf())
      await di.init()

      const svc = di.get(CacheTarget)
      svc.fetch()
      svc.noop()

      expect(cacheSpy).toHaveBeenCalledOnce()
      expect(cacheSpy).toHaveBeenCalledWith(60)
    })

    it('should expose class-level annotation via jp.annotations inside around hook', async function () {
      classAnnSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-class-ann'] })
      di.bind(ReportSvc, t => t.toSelf())
      await di.init()

      di.get(ReportSvc).generate()

      expect(classAnnSpy).toHaveBeenCalledOnce()
      expect(classAnnSpy).toHaveBeenCalledWith('REPORT')
    })
  })

  describe('pattern method matching', function () {
    class PatternTarget {
      findUser(): string { return 'user' }
      findOrder(): string { return 'order' }
      saveUser(): string { return 'saved' }
      deleteOrder(): string { return 'deleted' }
    }

    const patternSpy = vi.fn()

    @Profile('aop-pattern-regex')
    @Aspect([$aop.forClass(PatternTarget, $aop.matchMethodPattern(/^find/))])
    class RegexAspect implements MethodAspect<PatternTarget> {
      before(jp: JoinPoint<PatternTarget>) { patternSpy('regex', jp.methodName) }
    }
    void RegexAspect

    const startsSpy = vi.fn()

    @Profile('aop-pattern-starts')
    @Aspect([$aop.forClass(PatternTarget, $aop.methodHasPrefix('save'))])
    class StartsWithAspect implements MethodAspect<PatternTarget> {
      before(jp: JoinPoint<PatternTarget>) { startsSpy(jp.methodName) }
    }
    void StartsWithAspect

    const endsSpy = vi.fn()

    @Profile('aop-pattern-ends')
    @Aspect([$aop.forClass(PatternTarget, $aop.methodHasSuffix('Order'))])
    class EndsWithAspect implements MethodAspect<PatternTarget> {
      before(jp: JoinPoint<PatternTarget>) { endsSpy(jp.methodName) }
    }
    void EndsWithAspect

    it('matchMethodPattern intercepts only methods whose names match the regex', async function () {
      patternSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-pattern-regex'] })
      di.bind(PatternTarget, t => t.toSelf())
      await di.init()

      const svc = di.get(PatternTarget)
      svc.findUser()
      svc.findOrder()
      svc.saveUser()
      svc.deleteOrder()

      expect(patternSpy).toHaveBeenCalledTimes(2)
      expect(patternSpy.mock.calls.map(([, m]) => m).sort()).toEqual(['findOrder', 'findUser'])
    })

    it('matchMethodStartsWith intercepts only methods whose names start with the prefix', async function () {
      startsSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-pattern-starts'] })
      di.bind(PatternTarget, t => t.toSelf())
      await di.init()

      const svc = di.get(PatternTarget)
      svc.findUser()
      svc.saveUser()
      svc.deleteOrder()

      expect(startsSpy).toHaveBeenCalledTimes(1)
      expect(startsSpy).toHaveBeenCalledWith('saveUser')
    })

    it('matchMethodEndsWith intercepts only methods whose names end with the suffix', async function () {
      endsSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-pattern-ends'] })
      di.bind(PatternTarget, t => t.toSelf())
      await di.init()

      const svc = di.get(PatternTarget)
      svc.findUser()
      svc.findOrder()
      svc.saveUser()
      svc.deleteOrder()

      expect(endsSpy).toHaveBeenCalledTimes(2)
      expect(endsSpy.mock.calls.map(([m]) => m).sort()).toEqual(['deleteOrder', 'findOrder'])
    })
  })

  describe('pointcut', function () {
    class SvcA {
      run() { return 'a' }
    }

    class SvcB {
      run() { return 'b' }
    }

    const matchClassSpy = vi.fn()

    @Aspect([$aop.pointcut($aop.matchClass(SvcA, SvcB), 'run')])
    @Profile('aop-match-class')
    class MatchClassAspect implements MethodAspect {
      before(jp: JoinPoint) { matchClassSpy((jp.target as any).constructor.name) }
    }
    void MatchClassAspect

    const kSvcLabel = token<any>(Symbol('svc-label'))

    @Label(kSvcLabel)
    @Injectable()
    class LabelSvcA {
      run() { return 'a' }
    }

    @Label(kSvcLabel)
    @Injectable()
    class LabelSvcB {
      run() { return 'b' }
    }

    const matchLabelSpy = vi.fn()

    @Aspect([$aop.pointcut($aop.matchLabel(kSvcLabel), 'run')])
    @Profile('aop-match-label')
    class LabelAspect implements MethodAspect {
      before(jp: JoinPoint) { matchLabelSpy((jp.target as any).constructor.name) }
    }
    void LabelAspect

    const kTagSvc = token<any>(Symbol('tag-svc'))
    const TaggedMethodAnn = createAnnotation<true>()

    @Tag(kTagSvc, true)
    @Injectable()
    class TaggedSvc {
      @TaggedMethodAnn(true)
      tagged() { return 'tagged' }

      untagged() { return 'untagged' }
    }

    const combinedSpy = vi.fn()

    const combinedMethodPred = (name: string | symbol, _d: any, cls: any) =>
      reflect.get(cls, TaggedMethodAnn, name) !== undefined
    @Aspect([$aop.pointcut($aop.matchTag(kTagSvc), combinedMethodPred)])
    @Profile('aop-combined')
    class CombinedAspect implements MethodAspect {
      before(jp: JoinPoint) { combinedSpy(jp.methodName) }
    }
    void CombinedAspect

    it('should intercept all classes matched by matchClass()', async function () {
      matchClassSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-match-class'] })
      di.bind(SvcA, t => t.toSelf())
      di.bind(SvcB, t => t.toSelf())
      await di.init()

      di.get(SvcA).run()
      di.get(SvcB).run()

      expect(matchClassSpy).toHaveBeenCalledTimes(2)
      expect(matchClassSpy.mock.calls.map(([n]) => n).sort()).toEqual(['SvcA', 'SvcB'])
    })

    it('should intercept all classes matched by matchLabel()', async function () {
      matchLabelSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-match-label'] })
      await di.init()

      di.get(LabelSvcA).run()
      di.get(LabelSvcB).run()

      expect(matchLabelSpy).toHaveBeenCalledTimes(2)
      expect(matchLabelSpy.mock.calls.map(([n]) => n).sort()).toEqual(['LabelSvcA', 'LabelSvcB'])
    })

    it('should apply combined class + method predicate', async function () {
      combinedSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-combined'] })
      await di.init()

      const svc = di.get(TaggedSvc)
      svc.tagged()
      svc.untagged()

      expect(combinedSpy).toHaveBeenCalledOnce()
      expect(combinedSpy).toHaveBeenCalledWith('tagged')
    })
  })

  describe('multiple targets', function () {
    class ArrayTargetA {
      run() { return 'a' }
    }

    class ArrayTargetB {
      run() { return 'b' }
    }

    const arraySpy = vi.fn()

    @Aspect([$aop.forClass(ArrayTargetA, 'run'), $aop.forClass(ArrayTargetB, 'run')])
    @Profile('aop-array-target')
    class ArrayTargetAspect implements MethodAspect {
      before(jp: JoinPoint) { arraySpy((jp.target as any).constructor.name) }
    }
    void ArrayTargetAspect

    it('should intercept matching method on all classes in the array', async function () {
      arraySpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-array-target'] })
      di.bind(ArrayTargetA, t => t.toSelf())
      di.bind(ArrayTargetB, t => t.toSelf())
      await di.init()

      di.get(ArrayTargetA).run()
      di.get(ArrayTargetB).run()

      expect(arraySpy).toHaveBeenCalledTimes(2)
      expect(arraySpy.mock.calls.map(([n]) => n).sort()).toEqual(['ArrayTargetA', 'ArrayTargetB'])
    })
  })

  describe('logging use case', function () {
    const LogAnnotation = createAnnotation<{ level: string }>()
    const LogClassAnnotation = createAnnotation<{ prefix: string }>()

    function Log(opts: { level: string }) {
      return LogAnnotation(opts)
    }

    function LogClass(opts: { prefix: string }) {
      return LogClassAnnotation(opts)
    }

    @Injectable()
    class LogTarget {
      @Log({ level: 'info' })
      process(input: string) { return `processed:${input}` }

      plain() { return 'plain' }

      fail(): never { throw new Error('log-error') }
    }

    const logEntrySpy = vi.fn()
    const logReturnSpy = vi.fn()
    const logErrorSpy = vi.fn()
    const logTimingSpy = vi.fn()
    const logLevelSpy = vi.fn()

    @Aspect([$aop.forClass(LogTarget, 'process')])
    @Profile('aop-log-entry-exit')
    class LogEntryExitAspect implements MethodAspect<LogTarget> {
      before(jp: JoinPoint<LogTarget>) { logEntrySpy(jp.methodName, jp.args) }

      afterReturn(jp: JoinPoint<LogTarget>, result: unknown) {
        logReturnSpy(jp.methodName, result)
        return result
      }
    }
    void LogEntryExitAspect

    @Aspect([$aop.forClass(LogTarget, 'fail')])
    @Profile('aop-log-error')
    class LogErrorAspect implements MethodAspect<LogTarget> {
      afterThrow(jp: JoinPoint<LogTarget>, error: Error) {
        logErrorSpy(jp.methodName, error.message)
        throw error
      }
    }
    void LogErrorAspect

    @Aspect([$aop.forClass(LogTarget, 'process')])
    @Profile('aop-log-timing')
    class LogTimingAspect implements MethodAspect<LogTarget> {
      around(jp: JoinPoint<LogTarget>) {
        const start = Date.now()
        const result = jp.proceed(...jp.args)
        logTimingSpy(jp.methodName, Date.now() - start >= 0)
        return result
      }
    }
    void LogTimingAspect

    @Aspect([$aop.forClass(LogTarget, (name, _desc, cls) => reflect.get(cls, LogAnnotation, name) !== undefined)])
    @Profile('aop-log-level')
    class LogLevelAspect implements MethodAspect<LogTarget> {
      before(jp: JoinPoint<LogTarget>) {
        const opts = reflect.get(jp.ctor, LogAnnotation, jp.methodName)!
        logLevelSpy(jp.methodName, opts.level)
      }
    }
    void LogLevelAspect

    @LogClass({ prefix: 'SVC' })
    @Injectable()
    class ClassLogTarget {
      process() { return 'ok' }
    }

    const classLogSpy = vi.fn()

    @Aspect([$aop.pointcut((_desc, cls) => reflect.get(cls, LogClassAnnotation) !== undefined)])
    @Profile('aop-log-class')
    class ClassLogAspect implements MethodAspect {
      before(jp: JoinPoint) {
        const opts = reflect.get(jp.ctor, LogClassAnnotation)!
        classLogSpy(opts.prefix, jp.methodName)
      }
    }
    void ClassLogAspect

    it('should log method entry and exit', async function () {
      logEntrySpy.mockClear()
      logReturnSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-log-entry-exit'] })
      di.bind(LogTarget, t => t.toSelf())
      await di.init()

      const result = di.get(LogTarget).process('hello')

      expect(result).toBe('processed:hello')
      expect(logEntrySpy).toHaveBeenCalledWith('process', ['hello'])
      expect(logReturnSpy).toHaveBeenCalledWith('process', 'processed:hello')
    })

    it('should log errors and rethrow', async function () {
      logErrorSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-log-error'] })
      di.bind(LogTarget, t => t.toSelf())
      await di.init()

      expect(() => di.get(LogTarget).fail()).toThrow('log-error')
      expect(logErrorSpy).toHaveBeenCalledWith('fail', 'log-error')
    })

    it('should measure timing via around hook', async function () {
      logTimingSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-log-timing'] })
      di.bind(LogTarget, t => t.toSelf())
      await di.init()

      di.get(LogTarget).process('x')

      expect(logTimingSpy).toHaveBeenCalledOnce()
      expect(logTimingSpy).toHaveBeenCalledWith('process', true)
    })

    it('should read log level from method annotation via jp.annotations', async function () {
      logLevelSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-log-level'] })
      di.bind(LogTarget, t => t.toSelf())
      await di.init()

      const svc = di.get(LogTarget)
      svc.process('x')
      svc.plain()

      expect(logLevelSpy).toHaveBeenCalledOnce()
      expect(logLevelSpy).toHaveBeenCalledWith('process', 'info')
    })

    it('should read log prefix from class annotation via jp.annotations', async function () {
      classLogSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-log-class'] })
      di.bind(ClassLogTarget, t => t.toSelf())
      await di.init()

      di.get(ClassLogTarget).process()

      expect(classLogSpy).toHaveBeenCalledOnce()
      expect(classLogSpy).toHaveBeenCalledWith('SVC', 'process')
    })
  })

  describe('async correctness', function () {
    class AsyncHookTarget {
      async compute(x: number): Promise<number> { return x * 2 }

      async reject(): Promise<never> { throw new Error('async-fail') }
    }

    const asyncAfterReturnSpy = vi.fn()
    const asyncAfterThrowSpy = vi.fn()
    const asyncAfterSpy = vi.fn()
    const asyncAfterFailSpy = vi.fn()

    @Aspect([$aop.forClass(AsyncHookTarget, 'compute')])
    @Profile('aop-async-after-return')
    class AsyncAfterReturnAspect implements MethodAspect<AsyncHookTarget> {
      afterReturn(_jp: JoinPoint<AsyncHookTarget>, result: unknown) {
        asyncAfterReturnSpy(result)
        return (result as number) + 1
      }
    }
    void AsyncAfterReturnAspect

    @Aspect([$aop.forClass(AsyncHookTarget, 'reject')])
    @Profile('aop-async-after-throw')
    class AsyncAfterThrowAspect implements MethodAspect<AsyncHookTarget> {
      afterThrow(_jp: JoinPoint<AsyncHookTarget>, error: Error) {
        asyncAfterThrowSpy(error.message)
      }
    }
    void AsyncAfterThrowAspect

    @Aspect([$aop.forClass(AsyncHookTarget, 'compute')])
    @Profile('aop-async-after')
    class AsyncAfterAspect implements MethodAspect<AsyncHookTarget> {
      after(_jp: JoinPoint<AsyncHookTarget>, result: unknown, error: Error | undefined) {
        asyncAfterSpy(result, error)
      }
    }
    void AsyncAfterAspect

    @Aspect([$aop.forClass(AsyncHookTarget, 'reject')])
    @Profile('aop-async-after-fail')
    class AsyncAfterFailAspect implements MethodAspect<AsyncHookTarget> {
      afterThrow() { /* swallow */ }

      after(_jp: JoinPoint<AsyncHookTarget>, result: unknown, error: Error | undefined) {
        asyncAfterFailSpy(result, error)
      }
    }
    void AsyncAfterFailAspect

    it('should pass resolved value to afterReturn (not raw Promise)', async function () {
      asyncAfterReturnSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-async-after-return'] })
      di.bind(AsyncHookTarget, t => t.toSelf())
      await di.init()

      const result = await di.get(AsyncHookTarget).compute(5)

      expect(asyncAfterReturnSpy).toHaveBeenCalledWith(10)
      expect(result).toBe(11)
    })

    it('should pass rejection error to afterThrow and swallow it', async function () {
      asyncAfterThrowSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-async-after-throw'] })
      di.bind(AsyncHookTarget, t => t.toSelf())
      await di.init()

      await expect(di.get(AsyncHookTarget).reject()).resolves.toBeUndefined()
      expect(asyncAfterThrowSpy).toHaveBeenCalledWith('async-fail')
    })

    it('should call after with resolved value on async success', async function () {
      asyncAfterSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-async-after'] })
      di.bind(AsyncHookTarget, t => t.toSelf())
      await di.init()

      await di.get(AsyncHookTarget).compute(3)

      expect(asyncAfterSpy).toHaveBeenCalledOnce()
      const [result, error] = asyncAfterSpy.mock.calls[0] as [unknown, Error | undefined]
      expect(result).toBe(6)
      expect(error).toBeUndefined()
    })

    it('should call after with error on async failure when swallowed', async function () {
      asyncAfterFailSpy.mockClear()

      const di = new CaffeineIoC({ profiles: ['aop-async-after-fail'] })
      di.bind(AsyncHookTarget, t => t.toSelf())
      await di.init()

      await di.get(AsyncHookTarget).reject()

      expect(asyncAfterFailSpy).toHaveBeenCalledOnce()
      const [result, error] = asyncAfterFailSpy.mock.calls[0] as [unknown, Error]
      expect(result).toBeUndefined()
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe('async-fail')
    })
  })

  describe('validations', function () {
    class NonSingletonTarget {
      run(): string { return 'ok' }
    }

    @Profile('aop-non-singleton')
    @Lifetime(Scopes.TRANSIENT)
    @Aspect([$aop.forClass(NonSingletonTarget, 'run')])
    class NonSingletonAspect implements MethodAspect {}
    void NonSingletonAspect

    it('throws ErrInvalidDecorator when @Aspect has no pointcuts', function () {
      expect(() => {
        @Aspect([])
        class NoPointcutAspect {}
        void NoPointcutAspect
      }).toThrow(ErrInvalidDecorator)
    })

    it('throws ErrInvalidAspect at compile time when aspect is not singleton scoped', async function () {
      const di = new CaffeineIoC({ profiles: ['aop-non-singleton'] })
      di.bind(NonSingletonTarget, t => t.toSelf())
      await expect(di.init()).rejects.toThrow(ErrInvalidAspect)
    })
  })

  describe('provider dependency', function () {
    const providerCallSpy = vi.fn()

    class ProviderTarget {
      run(): string { return 'done' }
    }

    @Injectable()
    @Lifetime(Scopes.TRANSIENT)
    @Profile('aop-provider')
    class InvocationToken {
      readonly id = Math.random()
    }

    @Profile('aop-provider')
    @Aspect([$aop.forClass(ProviderTarget, 'run')], [$i.provide(InvocationToken)])
    class ProviderAspect implements MethodAspect {
      constructor(private readonly token: Provider<InvocationToken>) {}
      before(): void {
        providerCallSpy(this.token.get().id)
      }
    }
    void ProviderAspect

    let di: CaffeineIoC

    beforeAll(async function () {
      di = new CaffeineIoC({ profiles: ['aop-provider'] })
      di.bind(ProviderTarget, t => t.toSelf())
      await di.init()
    })

    it('aspect with Provider<T> constructor dep initializes without error', function () {
      expect(di.get(ProviderTarget)).toBeInstanceOf(ProviderTarget)
    })

    it('Provider<T>.get() inside before hook returns a fresh transient instance on each call', function () {
      providerCallSpy.mockClear()
      di.get(ProviderTarget).run()
      di.get(ProviderTarget).run()

      expect(providerCallSpy).toHaveBeenCalledTimes(2)
      const [id1, id2] = providerCallSpy.mock.calls.map((c: unknown[]) => c[0] as number)
      expect(id1).not.toBe(id2)
    })

    it('aspect still intercepts the target method', function () {
      providerCallSpy.mockClear()
      const result = di.get(ProviderTarget).run()
      expect(result).toBe('done')
      expect(providerCallSpy).toHaveBeenCalledOnce()
    })
  })

  describe('manual aspect binding', function () {
    const manualSpy = vi.fn()

    class ManualTarget {
      run(): string { return 'manual-result' }
    }

    class ManualAspect implements MethodAspect<ManualTarget> {
      before() { manualSpy() }
    }

    const manualDepSpy = vi.fn()

    class ManualDepTarget {
      run(): string { return 'dep-result' }
    }

    class ManualDep {
      readonly tag = 'dep-tag'
    }

    class ManualDepAspect implements MethodAspect<ManualDepTarget> {
      constructor(readonly dep: ManualDep) {}
      before() { manualDepSpy(this.dep.tag) }
    }

    const manualOrderLog: string[] = []

    class ManualOrderTarget {
      run(): string { return 'ordered' }
    }

    class ManualOuterAspect implements MethodAspect<ManualOrderTarget> {
      before() { manualOrderLog.push('outer-before') }
      after() { manualOrderLog.push('outer-after') }
    }

    class ManualInnerAspect implements MethodAspect<ManualOrderTarget> {
      before() { manualOrderLog.push('inner-before') }
      after() { manualOrderLog.push('inner-after') }
    }

    const condSpy = vi.fn()

    class CondTarget {
      run(): string { return 'cond-result' }
    }

    class CondAspect implements MethodAspect<CondTarget> {
      before() { condSpy() }
    }

    const asyncFactorySpy = vi.fn()

    class AsyncFactoryTarget {
      run(): string { return 'async-factory-result' }
    }

    class AsyncFactoryAspect implements MethodAspect<AsyncFactoryTarget> {
      before() { asyncFactorySpy() }
    }

    it('aspect().toSelf().pointcuts() weaves and intercepts the target method', async function () {
      manualSpy.mockClear()

      const di = new CaffeineIoC({ decorators: false })
      di.bind(ManualTarget, t => t.toSelf())
      di.aspect(ManualAspect, t => t.toSelf().pointcuts($aop.forClass(ManualTarget, 'run')))
      await di.init()

      const result = di.get(ManualTarget).run()
      expect(result).toBe('manual-result')
      expect(manualSpy).toHaveBeenCalledOnce()
    })

    it('toSelf(injections) wires constructor injections into the aspect', async function () {
      manualDepSpy.mockClear()

      const di = new CaffeineIoC({ decorators: false })
      di.bind(ManualDepTarget, t => t.toSelf())
      di.bind(ManualDep, t => t.toSelf())
      di.aspect(ManualDepAspect, t => t
        .toSelf([ManualDep])
        .pointcuts($aop.forClass(ManualDepTarget, 'run')))
      await di.init()

      di.get(ManualDepTarget).run()
      expect(manualDepSpy).toHaveBeenCalledWith('dep-tag')
    })

    it('order() before pointcuts() controls weaving priority', async function () {
      manualOrderLog.length = 0

      const di = new CaffeineIoC({ decorators: false })
      di.bind(ManualOrderTarget, t => t.toSelf())
      di.aspect(ManualOuterAspect, t => t.toSelf().order(1).pointcuts($aop.forClass(ManualOrderTarget, 'run')))
      di.aspect(ManualInnerAspect, t => t.toSelf().order(10).pointcuts($aop.forClass(ManualOrderTarget, 'run')))
      await di.init()

      di.get(ManualOrderTarget).run()
      expect(manualOrderLog).toEqual(['outer-before', 'inner-before', 'inner-after', 'outer-after'])
    })

    it('order() after pointcuts() is synced back and controls weaving priority', async function () {
      manualOrderLog.length = 0

      const di = new CaffeineIoC({ decorators: false })
      di.bind(ManualOrderTarget, t => t.toSelf())
      di.aspect(ManualOuterAspect, t => t.toSelf().pointcuts($aop.forClass(ManualOrderTarget, 'run')).order(1))
      di.aspect(ManualInnerAspect, t => t.toSelf().pointcuts($aop.forClass(ManualOrderTarget, 'run')).order(10))
      await di.init()

      di.get(ManualOrderTarget).run()
      expect(manualOrderLog).toEqual(['outer-before', 'inner-before', 'inner-after', 'outer-after'])
    })

    it('throws ErrInvalidContainerState when aspect() is called after init', async function () {
      const di = new CaffeineIoC({ decorators: false })
      await di.init()
      expect(() => di.aspect(ManualAspect, t => t.toSelf())).toThrow(ErrInvalidContainerState)
    })

    it('conditional() skips weaving when condition evaluates to false', async function () {
      condSpy.mockClear()

      const di = new CaffeineIoC({ decorators: false })
      di.bind(CondTarget, t => t.toSelf())
      di.aspect(CondAspect, t => t
        .toSelf()
        .pointcuts($aop.forClass(CondTarget, 'run'))
        .conditional(() => false))
      await di.init()

      di.get(CondTarget).run()
      expect(condSpy).not.toHaveBeenCalled()
    })

    it('toAsyncFactory() aspect is resolved and weaves correctly', async function () {
      asyncFactorySpy.mockClear()

      const di = new CaffeineIoC({ decorators: false })
      di.bind(AsyncFactoryTarget, t => t.toSelf())
      di.aspect(AsyncFactoryAspect, t => t
        .toAsyncFactory(async () => new AsyncFactoryAspect())
        .pointcuts($aop.forClass(AsyncFactoryTarget, 'run')))
      await di.init()

      di.get(AsyncFactoryTarget).run()
      expect(asyncFactorySpy).toHaveBeenCalledOnce()
    })
  })
})

// ─── this binding and instanceof ─────────────────────────────────────────────

describe('this binding and instanceof', function () {
  // (a) self-call: this.methodB() inside intercepted methodA goes through the proxy
  class SelfCallTarget {
    methodA(): string { return 'a:' + this.methodB() }
    methodB(): string { return 'b' }
  }

  const selfCallSpy = vi.fn()

  @Aspect([$aop.forClass(SelfCallTarget)])
  @Profile('aop-self-call')
  class SelfCallAspect implements MethodAspect<SelfCallTarget> {
    before(jp: JoinPoint<SelfCallTarget>) { selfCallSpy(jp.methodName) }
  }
  void SelfCallAspect

  it('this.method() inside intercepted method is intercepted via the proxy', async function () {
    selfCallSpy.mockClear()

    const di = new CaffeineIoC({ profiles: ['aop-self-call'] })
    di.bind(SelfCallTarget, t => t.toSelf())
    await di.init()

    const result = di.get(SelfCallTarget).methodA()

    expect(result).toBe('a:b')
    expect(selfCallSpy).toHaveBeenCalledTimes(2)
    expect(selfCallSpy.mock.calls.map(([m]) => m).sort()).toEqual(['methodA', 'methodB'])
  })

  // (b) return this: builder chaining routes returned value through the proxy
  class BuilderTarget {
    private _name = ''
    setName(name: string): this {
      this._name = name
      return this
    }

    getName(): string { return this._name }
  }

  const builderSpy = vi.fn()

  @Aspect([$aop.forClass(BuilderTarget)])
  @Profile('aop-builder-chain')
  class BuilderAspect implements MethodAspect<BuilderTarget> {
    before(jp: JoinPoint<BuilderTarget>) { builderSpy(jp.methodName) }
  }
  void BuilderAspect

  it('return this chaining works and chained call is still intercepted', async function () {
    builderSpy.mockClear()

    const di = new CaffeineIoC({ profiles: ['aop-builder-chain'] })
    di.bind(BuilderTarget, t => t.toSelf())
    await di.init()

    const result = di.get(BuilderTarget).setName('test').getName()

    expect(result).toBe('test')
    expect(builderSpy).toHaveBeenCalledTimes(2)
    expect(builderSpy.mock.calls.map(([m]) => m)).toEqual(['setName', 'getName'])
  })

  // (c) instanceof: Proxy has no getPrototypeOf trap; prototype chain is preserved
  class InstanceofTarget {
    run(): string { return 'ok' }
  }

  @Aspect([$aop.forClass(InstanceofTarget, 'run')])
  @Profile('aop-instanceof')
  class InstanceofAspect implements MethodAspect<InstanceofTarget> {
    before() { /* noop */ }
  }
  void InstanceofAspect

  it('instanceof check returns true for proxied instances', async function () {
    const di = new CaffeineIoC({ profiles: ['aop-instanceof'] })
    di.bind(InstanceofTarget, t => t.toSelf())
    await di.init()

    const instance = di.get(InstanceofTarget)
    expect(instance instanceof InstanceofTarget).toBe(true)
  })
})

// ─── multiple aspects on the same method ─────────────────────────────────────

describe('multiple aspects on the same method', function () {
  class MultiAspectTarget {
    add(a: number, b: number): number { return a + b }
    fail(): never { throw new Error('multi-fail') }
    async asyncFail(): Promise<never> { throw new Error('async-multi-fail') }
  }

  // 1. no explicit order — both fire
  const noOrderLog: string[] = []

  @Aspect([$aop.forClass(MultiAspectTarget, 'add')])
  @Profile('aop-multi-no-order')
  class NoOrderAspectA implements MethodAspect<MultiAspectTarget> {
    before() { noOrderLog.push('A-before') }
    after() { noOrderLog.push('A-after') }
  }
  void NoOrderAspectA

  @Aspect([$aop.forClass(MultiAspectTarget, 'add')])
  @Profile('aop-multi-no-order')
  class NoOrderAspectB implements MethodAspect<MultiAspectTarget> {
    before() { noOrderLog.push('B-before') }
    after() { noOrderLog.push('B-after') }
  }
  void NoOrderAspectB

  it('both aspects run when no @Order is specified', async function () {
    noOrderLog.length = 0

    const di = new CaffeineIoC({ profiles: ['aop-multi-no-order'] })
    di.bind(MultiAspectTarget, t => t.toSelf())
    await di.init()

    di.get(MultiAspectTarget).add(1, 2)

    expect(noOrderLog).toContain('A-before')
    expect(noOrderLog).toContain('B-before')
    expect(noOrderLog).toContain('A-after')
    expect(noOrderLog).toContain('B-after')
  })

  // 2. two around hooks both calling proceed
  @Order(1)
  @Aspect([$aop.forClass(MultiAspectTarget, 'add')])
  @Profile('aop-multi-around')
  class OuterAroundAspect implements MethodAspect<MultiAspectTarget> {
    around(jp: JoinPoint<MultiAspectTarget>) {
      return (jp.proceed(...jp.args) as number) + 100
    }
  }
  void OuterAroundAspect

  @Order(10)
  @Aspect([$aop.forClass(MultiAspectTarget, 'add')])
  @Profile('aop-multi-around')
  class InnerAroundAspect implements MethodAspect<MultiAspectTarget> {
    around(jp: JoinPoint<MultiAspectTarget>) {
      return (jp.proceed(...jp.args) as number) * 2
    }
  }
  void InnerAroundAspect

  it('two around hooks both calling proceed compose in onion order', async function () {
    const di = new CaffeineIoC({ profiles: ['aop-multi-around'] })
    di.bind(MultiAspectTarget, t => t.toSelf())
    await di.init()

    // target: 1+2=3, inner*2=6, outer+100=106
    expect(di.get(MultiAspectTarget).add(1, 2)).toBe(106)
  })

  // 3. afterReturn chain — inner transforms first, outer sees transformed value
  @Order(1)
  @Aspect([$aop.forClass(MultiAspectTarget, 'add')])
  @Profile('aop-multi-after-return')
  class OuterAfterReturnAspect implements MethodAspect<MultiAspectTarget> {
    afterReturn(_jp: JoinPoint<MultiAspectTarget>, result: unknown) {
      return (result as number) * 2
    }
  }
  void OuterAfterReturnAspect

  @Order(10)
  @Aspect([$aop.forClass(MultiAspectTarget, 'add')])
  @Profile('aop-multi-after-return')
  class InnerAfterReturnAspect implements MethodAspect<MultiAspectTarget> {
    afterReturn(_jp: JoinPoint<MultiAspectTarget>, result: unknown) {
      return (result as number) + 1
    }
  }
  void InnerAfterReturnAspect

  it('afterReturn values chain: inner runs first, outer sees inner-transformed result', async function () {
    const di = new CaffeineIoC({ profiles: ['aop-multi-after-return'] })
    di.bind(MultiAspectTarget, t => t.toSelf())
    await di.init()

    // target: 1+2=3, inner+1=4, outer*2=8
    expect(di.get(MultiAspectTarget).add(1, 2)).toBe(8)
  })

  // 4. before arg mutation is visible to inner aspect
  const argMutationLog: number[][] = []

  @Order(1)
  @Aspect([$aop.forClass(MultiAspectTarget, 'add')])
  @Profile('aop-multi-arg-mutation')
  class ArgMutatorAspect implements MethodAspect<MultiAspectTarget> {
    before(jp: JoinPoint<MultiAspectTarget>) {
      jp.args = [99, 1]
    }
  }
  void ArgMutatorAspect

  @Order(10)
  @Aspect([$aop.forClass(MultiAspectTarget, 'add')])
  @Profile('aop-multi-arg-mutation')
  class ArgObserverAspect implements MethodAspect<MultiAspectTarget> {
    before(jp: JoinPoint<MultiAspectTarget>) {
      argMutationLog.push([...jp.args] as number[])
    }
  }
  void ArgObserverAspect

  it('outer before arg mutation is visible to inner before', async function () {
    argMutationLog.length = 0

    const di = new CaffeineIoC({ profiles: ['aop-multi-arg-mutation'] })
    di.bind(MultiAspectTarget, t => t.toSelf())
    await di.init()

    const result = di.get(MultiAspectTarget).add(1, 2)

    expect(argMutationLog).toHaveLength(1)
    expect(argMutationLog[0]).toEqual([99, 1])
    expect(result).toBe(100)
  })

  // 5. outer around short-circuits — inner never runs
  const shortCircuitLog: string[] = []

  @Order(1)
  @Aspect([$aop.forClass(MultiAspectTarget, 'add')])
  @Profile('aop-multi-short-circuit')
  class ShortCircuitOuterAspect implements MethodAspect<MultiAspectTarget> {
    around() { return -1 }
  }
  void ShortCircuitOuterAspect

  @Order(10)
  @Aspect([$aop.forClass(MultiAspectTarget, 'add')])
  @Profile('aop-multi-short-circuit')
  class ShortCircuitInnerAspect implements MethodAspect<MultiAspectTarget> {
    before() { shortCircuitLog.push('inner-before') }
    after() { shortCircuitLog.push('inner-after') }
  }
  void ShortCircuitInnerAspect

  it('outer around without proceed short-circuits: inner hooks never fire', async function () {
    shortCircuitLog.length = 0

    const di = new CaffeineIoC({ profiles: ['aop-multi-short-circuit'] })
    di.bind(MultiAspectTarget, t => t.toSelf())
    await di.init()

    expect(di.get(MultiAspectTarget).add(1, 2)).toBe(-1)
    expect(shortCircuitLog).toEqual([])
  })

  // 6. inner swallows error — outer after sees undefined result, no error
  const swallowOuterAfterLog: [unknown, Error | undefined][] = []

  @Order(1)
  @Aspect([$aop.forClass(MultiAspectTarget, 'fail')])
  @Profile('aop-multi-swallow-inner')
  class SwallowOuterAspect implements MethodAspect<MultiAspectTarget> {
    after(_jp: JoinPoint<MultiAspectTarget>, result: unknown, error: Error | undefined) {
      swallowOuterAfterLog.push([result, error])
    }
  }
  void SwallowOuterAspect

  @Order(10)
  @Aspect([$aop.forClass(MultiAspectTarget, 'fail')])
  @Profile('aop-multi-swallow-inner')
  class SwallowInnerAspect implements MethodAspect<MultiAspectTarget> {
    afterThrow() { /* swallow */ }
  }
  void SwallowInnerAspect

  it('when inner swallows error, outer after sees result=undefined and no error', async function () {
    swallowOuterAfterLog.length = 0

    const di = new CaffeineIoC({ profiles: ['aop-multi-swallow-inner'] })
    di.bind(MultiAspectTarget, t => t.toSelf())
    await di.init()

    expect(() => di.get(MultiAspectTarget).fail()).not.toThrow()
    expect(swallowOuterAfterLog).toHaveLength(1)
    const [result, error] = swallowOuterAfterLog[0]
    expect(result).toBeUndefined()
    expect(error).toBeUndefined()
  })

  // 7. inner has no afterThrow, error propagates to outer which swallows it
  @Order(1)
  @Aspect([$aop.forClass(MultiAspectTarget, 'fail')])
  @Profile('aop-multi-outer-swallow')
  class OuterSwallowAspect implements MethodAspect<MultiAspectTarget> {
    afterThrow() { /* swallow */ }
  }
  void OuterSwallowAspect

  @Order(10)
  @Aspect([$aop.forClass(MultiAspectTarget, 'fail')])
  @Profile('aop-multi-outer-swallow')
  class InnerNoHandlerAspect implements MethodAspect<MultiAspectTarget> {
    before() { /* noop */ }
  }
  void InnerNoHandlerAspect

  it('error not caught by inner propagates to outer which can swallow it', async function () {
    const di = new CaffeineIoC({ profiles: ['aop-multi-outer-swallow'] })
    di.bind(MultiAspectTarget, t => t.toSelf())
    await di.init()

    expect(() => di.get(MultiAspectTarget).fail()).not.toThrow()
  })

  // 8. async afterThrow that rejects must propagate (regression for bug fix)
  @Aspect([$aop.forClass(MultiAspectTarget, 'asyncFail')])
  @Profile('aop-async-after-throw-rethrow')
  class AsyncRethrowAspect implements MethodAspect<MultiAspectTarget> {
    async afterThrow(_jp: JoinPoint<MultiAspectTarget>, err: Error) {
      throw err
    }
  }
  void AsyncRethrowAspect

  it('async afterThrow that rejects must propagate the rejection to the caller', async function () {
    const di = new CaffeineIoC({ profiles: ['aop-async-after-throw-rethrow'] })
    di.bind(MultiAspectTarget, t => t.toSelf())
    await di.init()

    await expect(di.get(MultiAspectTarget).asyncFail()).rejects.toThrow('async-multi-fail')
  })

  // 9. 3 aspects — full onion order
  const threeAspectLog: string[] = []

  @Order(1)
  @Aspect([$aop.forClass(MultiAspectTarget, 'add')])
  @Profile('aop-three-aspects')
  class ThreeOuterAspect implements MethodAspect<MultiAspectTarget> {
    before() { threeAspectLog.push('outer-before') }
    after() { threeAspectLog.push('outer-after') }
  }
  void ThreeOuterAspect

  @Order(5)
  @Aspect([$aop.forClass(MultiAspectTarget, 'add')])
  @Profile('aop-three-aspects')
  class ThreeMidAspect implements MethodAspect<MultiAspectTarget> {
    before() { threeAspectLog.push('mid-before') }
    after() { threeAspectLog.push('mid-after') }
  }
  void ThreeMidAspect

  @Order(10)
  @Aspect([$aop.forClass(MultiAspectTarget, 'add')])
  @Profile('aop-three-aspects')
  class ThreeInnerAspect implements MethodAspect<MultiAspectTarget> {
    before() { threeAspectLog.push('inner-before') }
    after() { threeAspectLog.push('inner-after') }
  }
  void ThreeInnerAspect

  it('3 aspects execute in full onion order: outer-mid-inner before, inner-mid-outer after', async function () {
    threeAspectLog.length = 0

    const di = new CaffeineIoC({ profiles: ['aop-three-aspects'] })
    di.bind(MultiAspectTarget, t => t.toSelf())
    await di.init()

    di.get(MultiAspectTarget).add(1, 2)

    expect(threeAspectLog).toEqual([
      'outer-before',
      'mid-before',
      'inner-before',
      'inner-after',
      'mid-after',
      'outer-after',
    ])
  })
})
