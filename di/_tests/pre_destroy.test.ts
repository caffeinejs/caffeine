import { randomUUID } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { PreDestroy } from '../decorators/pre_destroy.js'
import { OnPreDestroy } from '../decorators/on_pre_destroy.js'
import { CaffeineIoC } from '../container.js'
import { Injectable } from '../decorators/injectable.js'
import { Configuration } from '../decorators/configuration.js'
import { Provides } from '../decorators/provides.js'
import { Scopes } from '../scope.js'
import { ErrInvalidDecorator } from '../errors.js'
import { Lazy } from '../decorators/lazy.js'

describe('PreDestroy', function () {
  it('should call method decorated with @PreDestroy() when the container is disposed', async function () {
    const nmspy = vi.fn()
    const mspy = vi.fn()

    class NonManaged {
      @PreDestroy()
      onDestroy() {
        nmspy()
      }
    }
    void NonManaged

    @Injectable()
    class Managed {
      @PreDestroy()
      onDestroy() {
        mspy()
      }
    }

    const di = new CaffeineIoC({ decorators: false })
    di.bind(Managed)
      .toSelf()
    await di.init()
    await di.dispose()

    expect(nmspy).not.toHaveBeenCalled()
    expect(mspy)
      .toHaveBeenCalledTimes(1)
  })

  describe('OnPreDestroy', function () {
    it('should call the fn with the produced instance on dispose', async function () {
      const spy = vi.fn()

      class ConnOPD {
        readonly id = randomUUID()
      }

      @Configuration()
      class AppConfigOPD {
        @OnPreDestroy((c: ConnOPD) => spy(c))
        @Provides(ConnOPD)
        conn(): ConnOPD {
          return new ConnOPD()
        }
      }

      void AppConfigOPD

      const di = new CaffeineIoC()
      await di.init()

      const instance = di.get(ConnOPD)
      await di.dispose()

      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy).toHaveBeenCalledWith(instance)
    })

    it('should await an async fn on dispose', async function () {
      const order: string[] = []

      class CacheOPD {
        readonly id = randomUUID()
      }

      @Configuration()
      class CacheConfigOPD {
        @OnPreDestroy(async (_c: CacheOPD) => {
          await Promise.resolve()
          order.push('destroyed')
        })
        @Provides(CacheOPD)
        cache(): CacheOPD {
          return new CacheOPD()
        }
      }

      void CacheConfigOPD

      const di = new CaffeineIoC()
      await di.init()

      di.get(CacheOPD)
      await di.dispose()

      expect(order).toEqual(['destroyed'])
    })

    it('should not call fn when the instance was never resolved (lazy, not cached)', async function () {
      const spy = vi.fn()

      class SvcOPD {}

      @Configuration()
      class SvcConfigOPD {
        @Lazy()
        @OnPreDestroy((_s: SvcOPD) => spy(_s))
        @Provides(SvcOPD)
        svc(): SvcOPD {
          return new SvcOPD()
        }
      }

      void SvcConfigOPD

      const di = new CaffeineIoC()
      await di.init()

      // Never call di.get(SvcOPD) → lazy bean never instantiated → not cached
      await di.dispose()

      expect(spy).not.toHaveBeenCalled()
    })

    it('should throw ErrInvalidDecorator when used on a non-method', function () {
      expect(() => {
        const fn = OnPreDestroy(() => {})
        fn(class Foo {}, { kind: 'class', name: 'Foo' } as unknown as DecoratorContext)
      }).toThrow(ErrInvalidDecorator)
    })
  })

  describe('resetBinding()', function () {
    it('should reset the cached instance when @PreDestroy throws', async function () {
      const destroySpy = vi.fn()

      @Injectable()
      class Svc {
        readonly id = randomUUID()

        @PreDestroy()
        destroy() {
          destroySpy()
          throw new Error('preDestroy boom')
        }
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Svc)
        .toSelf()
        .lifetime(Scopes.SINGLETON)
      await di.init()

      const before = di.get(Svc)

      await expect(di.resetBinding(di.getBinding(Svc)!)).rejects.toThrow('preDestroy boom')

      expect(destroySpy)
        .toHaveBeenCalledTimes(1)

      const after = di.get(Svc)
      expect(after).not.toBe(before)
      expect(after.id).not.toBe(before.id)
    })

    it('should reset the cached instance when @PreDestroy succeeds', async function () {
      const destroySpy = vi.fn()

      @Injectable()
      class Svc {
        readonly id = randomUUID()

        @PreDestroy()
        destroy() {
          destroySpy()
        }
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(Svc)
        .toSelf()
        .lifetime(Scopes.SINGLETON)
      await di.init()

      const before = di.get(Svc)

      await di.resetBinding(di.getBinding(Svc)!)

      expect(destroySpy)
        .toHaveBeenCalledTimes(1)

      const after = di.get(Svc)
      expect(after).not.toBe(before)
      expect(after.id).not.toBe(before.id)
    })
  })
})
