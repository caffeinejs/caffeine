import 'reflect-metadata'
import { describe, it, beforeAll, expect, vi } from 'vitest'
import { CaffeineIoC } from '../../../container.js'
import { Injectable } from '../injectable.legacy.js'
import { Named } from '../named.legacy.js'
import { Lifetime } from '../lifetime.legacy.js'
import { composeDecorators } from '../compose_decorators.legacy.js'
import { Scopes } from '../../../scope.js'

type AnyDecorator = (target: object | Function, propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => void

describe('Legacy composeDecorators', function () {
  describe('singleton + injectable composition', function () {
    const SingletonBean = composeDecorators(Lifetime(Scopes.SINGLETON) as AnyDecorator, Injectable() as AnyDecorator)

    @SingletonBean
    class ComposedSingletonSvc {}

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('registers class as singleton via composed decorators', function () {
      const a = di.get(ComposedSingletonSvc)
      const b = di.get(ComposedSingletonSvc)
      expect(a).toBeInstanceOf(ComposedSingletonSvc)
      expect(a).toBe(b)
    })
  })

  describe('named + injectable composition', function () {
    const COMPOSED_KEY = 'legacy-composed-named'
    const NamedBean = composeDecorators(Named(COMPOSED_KEY) as AnyDecorator, Injectable() as AnyDecorator)

    @NamedBean
    class ComposedNamedSvc {}

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('registers class with named key via composed decorators', function () {
      expect(di.get(COMPOSED_KEY)).toBeInstanceOf(ComposedNamedSvc)
    })
  })

  describe('transient + injectable composition', function () {
    const TransientBean = composeDecorators(Lifetime(Scopes.TRANSIENT) as AnyDecorator, Injectable() as AnyDecorator)

    @TransientBean
    class ComposedTransientSvc {}

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('registers class as transient via composed decorators', function () {
      const a = di.get(ComposedTransientSvc)
      const b = di.get(ComposedTransientSvc)
      expect(a).toBeInstanceOf(ComposedTransientSvc)
      expect(a).not.toBe(b)
    })
  })

  describe('decorator application order', function () {
    it('applies decorators left-to-right', function () {
      const order: number[] = []
      const d1 = (target: object | Function) => {
        order.push(1)
        void target
      }
      const d2 = (target: object | Function) => {
        order.push(2)
        void target
      }
      const d3 = (target: object | Function) => {
        order.push(3)
        void target
      }

      const composed = composeDecorators(d1, d2, d3)
      composed(class {})

      expect(order).toEqual([1, 2, 3])
    })

    it('passes propertyKey and descriptor to each decorator', function () {
      const spy = vi.fn()
      const d = (target: object | Function, pk?: string | symbol, desc?: PropertyDescriptor) => {
        spy(pk, desc)
      }
      const composed = composeDecorators(d, d)
      const desc = { value: () => {} }
      composed({}, 'method', desc as PropertyDescriptor)

      expect(spy).toHaveBeenCalledTimes(2)
      expect(spy).toHaveBeenCalledWith('method', desc)
    })
  })
})
