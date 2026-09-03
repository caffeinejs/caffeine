import { describe, it, expect } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Configuration } from '../decorators/configuration.js'
import { Injectable } from '../decorators/injectable.js'
import { Label } from '../decorators/label.js'
import { Lifetime } from '../decorators/lifetime.js'
import { Provides } from '../decorators/provides.js'
import {
  defineMemberInjection,
  extendInjectableAttributes,
  extendMemberInjectableAttributes,
  defineInjectable,
} from '../decorators/registrar/index.js'
import { token } from '../key.js'
import { Scopes } from '../scope.js'
import { Ctor } from '../types.js'

describe('Custom decorator primitives', function () {
  describe('configureInjectable — static partial', function () {
    const LazyClass = (target: Ctor, context: ClassDecoratorContext) => {
      extendInjectableAttributes(context, target, config => config.lazy(true))
    }

    @LazyClass
    @Injectable()
    class StaticLazy {}

    it('should apply a static partial to the class binding', function () {
      const di = new CaffeineIoC()
      const binding = di.getBindings(StaticLazy)[0]
      expect(binding.lazy).toBe(true)
    })
  })

  describe('configureInjectable — factory with metadata', function () {
    const kDep = token<FieldDep>(Symbol('dep-field'))

    function MyFieldInject(key: symbol) {
      return (_target: Function | object | undefined, context: ClassMemberDecoratorContext) => {
        defineMemberInjection(context.metadata, context.name, context.kind, {
          key: token<Record<string, unknown>>(key),
        })
      }
    }

    const RegisterWithInject = (target: Ctor, context: ClassDecoratorContext) => {
      defineInjectable(context.metadata, target, config => config.type(target as Function).dependencies([]))
    }

    @Injectable()
    class FieldDep {
      value = 'injected'
    }

    @RegisterWithInject
    class FieldConsumer {
      @MyFieldInject(kDep) dep!: FieldDep
    }

    it('should expose injectableProperties from metadata in the factory', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kDep, t => t.toClass(FieldDep))
      di.bind(FieldConsumer, t => t.toSelf())

      await di.init()

      const consumer = di.get(FieldConsumer)
      expect(consumer.dep).toBeInstanceOf(FieldDep)
      expect(consumer.dep.value).toBe('injected')
    })
  })

  describe('configureMethodOrPropertyInjectable — method partial', function () {
    const LazyBean = (_target: object, context: ClassMethodDecoratorContext) =>
      extendMemberInjectableAttributes(context.metadata, context.name, config => config.lazy(true))
    const kService = token<Record<string, unknown>>(Symbol('lazy-bean'))

    @Configuration()
    class ConfLazyBean {
      @Provides(kService)
      @LazyBean
      service() {
        return { ready: true }
      }
    }
    void ConfLazyBean

    it('should apply a partial to a @Provides method making it lazy', function () {
      const di = new CaffeineIoC()
      const binding = di.getBindings(kService)[0]
      expect(binding.lazy).toBe(true)
    })
  })

  describe('stacked class decorators', function () {
    @Injectable()
    @Lifetime(Scopes.TRANSIENT)
    class TransientSvc {}

    it('should apply Injectable and Lifetime on the same class', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(TransientSvc, t => t.toSelf())
      await di.init()
      const a = di.get(TransientSvc)
      const b = di.get(TransientSvc)
      expect(a).toBeInstanceOf(TransientSvc)
      expect(a).not.toBe(b)
    })

    const sym = Symbol('composed-label')

    @Injectable()
    @Label(sym)
    class ComposedCtrl {}

    it('should apply Injectable and Label and accumulate all contributions', function () {
      const di = new CaffeineIoC()
      expect(di.has(ComposedCtrl)).toBe(true)
      const result = di.getBindingsBy(descriptor => descriptor.binding.labels.includes(sym))
      expect(result).toHaveLength(1)
      expect(result[0].key).toBe(ComposedCtrl)
    })
  })

  describe('configureInjectionMetadata', function () {
    const kCustomDep = token<TargetService>(Symbol('custom-dep'))

    function MyInject(key: symbol) {
      return (_target: Function | object | undefined, context: ClassMemberDecoratorContext) => {
        defineMemberInjection(context.metadata, context.name, context.kind, {
          key: token<Record<string, unknown>>(key),
        })
      }
    }

    @Injectable()
    class TargetService {
      value = 'service'
    }

    @Injectable()
    class TargetConsumer {
      @MyInject(kCustomDep) dep!: TargetService
    }

    it('should build a custom field injection decorator that resolves correctly', async function () {
      const di = new CaffeineIoC({ decorators: false })
      di.bind(kCustomDep, t => t.toClass(TargetService))
      di.bind(TargetConsumer, t => t.toSelf())
      await di.init()
      const consumer = di.get(TargetConsumer) as TargetConsumer
      expect(consumer.dep).toBeInstanceOf(TargetService)
      expect(consumer.dep.value).toBe('service')
    })
  })
})
