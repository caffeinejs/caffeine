import 'reflect-metadata'
import { describe, it, beforeAll, expect, vi } from 'vitest'
import { CaffeineIoC } from '../../../container.js'
import { Injectable } from '../injectable.legacy.js'
import { Lifetime } from '../lifetime.legacy.js'
import { Scopes } from '../../../scope.js'
import { UseFactory } from '../use_factory.legacy.js'

describe('Legacy @UseFactory', function () {
  describe('basic factory', function () {
    @UseFactory(() => {
      const b = new SingletonBean()
      b.builtBy = 'factory'
      return b
    })
    @Injectable()
    class SingletonBean {
      builtBy = 'constructor'
    }

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('uses custom factory to create instance', function () {
      const bean = di.get(SingletonBean)
      expect(bean).toBeInstanceOf(SingletonBean)
      expect(bean.builtBy).toBe('factory')
    })

    it('singleton returns same instance', function () {
      const a = di.get(SingletonBean)
      const b = di.get(SingletonBean)
      expect(a).toBe(b)
    })
  })

  describe('factory called per resolution for transient', function () {
    const factorySpy = vi.fn()

    @UseFactory(() => {
      factorySpy()
      return new TransientBean()
    })
    @Lifetime(Scopes.TRANSIENT)
    @Injectable()
    class TransientBean {
      readonly id = Math.random()
    }

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('calls factory for each transient resolution', function () {
      factorySpy.mockClear()
      const a = di.get(TransientBean)
      const b = di.get(TransientBean)
      expect(factorySpy).toHaveBeenCalledTimes(2)
      expect(a).not.toBe(b)
    })
  })

  describe('factory receives ResolutionContext', function () {
    const capturedCtx: unknown[] = []

    @UseFactory(ctx => {
      capturedCtx.push(ctx)
      return new ContextBean()
    })
    @Injectable()
    class ContextBean {}

    const di = new CaffeineIoC()

    beforeAll(async () => {
      await di.init()
    })

    it('factory receives resolution context with key', function () {
      di.get(ContextBean)
      expect(capturedCtx.length).toBeGreaterThan(0)
      const ctx = capturedCtx[0] as { key: unknown }
      expect(ctx).toHaveProperty('key')
    })
  })
})
