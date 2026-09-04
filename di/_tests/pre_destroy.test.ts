import { randomUUID } from 'node:crypto'

import { describe, it, expect, vi } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Configuration } from '../decorators/configuration.js'
import { Injectable } from '../decorators/injectable.js'
import { Lazy } from '../decorators/lazy.js'
import { OnPreDestroy } from '../decorators/on_pre_destroy.js'
import { PreDestroy } from '../decorators/pre_destroy.js'
import { Provides } from '../decorators/provides.js'
import { ErrInvalidDecorator } from '../errors.js'
import { token } from '../key.js'
import { Scopes } from '../scope.js'

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
    di.bind(Managed, t => t.toSelf())
    await di.init()
    await di.dispose()

    expect(nmspy).not.toHaveBeenCalled()
    expect(mspy).toHaveBeenCalledTimes(1)
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
      di.bind(Svc, t => t.toSelf().lifetime(Scopes.SINGLETON))
      await di.init()

      const before = di.get(Svc)

      await expect(di.resetBinding(di.getBinding(Svc)!)).rejects.toThrow('preDestroy boom')

      expect(destroySpy).toHaveBeenCalledTimes(1)

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
      di.bind(Svc, t => t.toSelf().lifetime(Scopes.SINGLETON))
      await di.init()

      const before = di.get(Svc)

      await di.resetBinding(di.getBinding(Svc)!)

      expect(destroySpy).toHaveBeenCalledTimes(1)

      const after = di.get(Svc)
      expect(after).not.toBe(before)
      expect(after.id).not.toBe(before.id)
    })
  })

  describe('dispose order', function () {
    // A dependency has to still be usable while its dependent's hook runs, so the instance created last is
    // the first one destroyed. Bindings are registered dependency-first, so registration order and the
    // expected teardown order are opposites.
    it('should destroy in reverse creation order, not registration order', async function () {
      const order: string[] = []

      class RepoDO {
        close() {
          order.push('repo')
        }
      }

      class ServiceDO {
        constructor(readonly repo: RepoDO) {}

        close() {
          order.push('service')
        }
      }

      class ApiDO {
        constructor(readonly service: ServiceDO) {}

        close() {
          order.push('api')
        }
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(RepoDO, t => t.toSelf().preDestroy(r => r.close()))
      di.bind(ServiceDO, t => t.toSelf([RepoDO]).preDestroy(s => s.close()))
      di.bind(ApiDO, t => t.toSelf([ServiceDO]).preDestroy(a => a.close()))
      await di.init()

      di.get(ApiDO)
      await di.dispose()

      expect(order).toEqual(['api', 'service', 'repo'])
    })

    // Ordering means nothing if the hooks overlap: a dependency could be closed while its dependent is still
    // awaiting inside its own hook.
    it('should await each hook before starting the next', async function () {
      const order: string[] = []

      class SlowRepoDO {}
      class SlowServiceDO {
        constructor(readonly repo: SlowRepoDO) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(SlowRepoDO, t =>
        t.toSelf().preDestroy(async () => {
          order.push('repo:start')
          await Promise.resolve()
          order.push('repo:end')
        }),
      )
      di.bind(SlowServiceDO, t =>
        t.toSelf([SlowRepoDO]).preDestroy(async () => {
          order.push('service:start')
          await Promise.resolve()
          order.push('service:end')
        }),
      )
      await di.init()

      di.get(SlowServiceDO)
      await di.dispose()

      expect(order).toEqual(['service:start', 'service:end', 'repo:start', 'repo:end'])
    })

    // Two keys can hand back one object. Closing the resource twice is what the identity check prevents.
    it('should run one hook per instance when two bindings share it', async function () {
      const pool = { closed: 0 }
      const kPoolA = token<{ closed: number }>(Symbol('pool-a'))
      const kPoolB = token<{ closed: number }>(Symbol('pool-b'))

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kPoolA, t => t.toValue(pool).preDestroy(p => void p.closed++))
      di.bind(kPoolB, t => t.toValue(pool).preDestroy(p => void p.closed++))
      await di.init()

      di.get(kPoolA)
      di.get(kPoolB)
      await di.dispose()

      expect(pool.closed).toBe(1)
    })

    // Identity is only meaningful for references: two bindings holding 8080 are two settings, not one socket.
    it('should keep a hook per binding when the instances are primitives', async function () {
      const seen: number[] = []
      const kPortA = token<number>(Symbol('port-a'))
      const kPortB = token<number>(Symbol('port-b'))

      const di = new CaffeineIoC({ decorators: false })
      di.bind(kPortA, t => t.toValue(8080).preDestroy(v => void seen.push(v)))
      di.bind(kPortB, t => t.toValue(8080).preDestroy(v => void seen.push(v)))
      await di.init()

      await di.dispose()

      expect(seen).toEqual([8080, 8080])
    })

    // Singleton and refresh keep separate caches; without a shared sequence their relative order is lost and
    // a refresh-scoped dependency can be torn down before the singleton that holds it.
    it('should order singleton and refresh instances against each other', async function () {
      const order: string[] = []

      class TokenXS {
        close() {
          order.push('token')
        }
      }

      class ClientXS {
        constructor(readonly token: TokenXS) {}

        close() {
          order.push('client')
        }
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(TokenXS, t =>
        t
          .toSelf()
          .lifetime(Scopes.REFRESH)
          .preDestroy(x => x.close()),
      )
      di.bind(ClientXS, t =>
        t
          .toSelf([TokenXS])
          .lifetime(Scopes.SINGLETON)
          .preDestroy(c => c.close()),
      )
      await di.init()

      di.get(ClientXS)
      await di.dispose()

      expect(order).toEqual(['client', 'token'])
    })

    it('should run every remaining hook when one throws and report the failures together', async function () {
      const after = vi.fn()

      class FirstCreatedFD {}
      class LastCreatedFD {
        constructor(readonly first: FirstCreatedFD) {}
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(FirstCreatedFD, t => t.toSelf().preDestroy(after))
      di.bind(LastCreatedFD, t =>
        t.toSelf([FirstCreatedFD]).preDestroy(() => {
          throw new Error('preDestroy boom')
        }),
      )
      await di.init()

      di.get(LastCreatedFD)

      await expect(di.dispose()).rejects.toThrow(AggregateError)
      expect(after).toHaveBeenCalledTimes(1)
      expect(di.ready).toBe(false)
    })

    // Disposal used to call scope.reset() on every binding, and SingletonScope.reset throws for async ones.
    it('should dispose a container holding an async binding', async function () {
      const spy = vi.fn()

      class ConnAD {
        readonly id = randomUUID()
      }

      const di = new CaffeineIoC({ decorators: false })
      di.bind(ConnAD, t => t.toAsyncFactory(async () => new ConnAD()).preDestroy(spy))
      await di.init()

      await expect(di.dispose()).resolves.toBeUndefined()
      expect(spy).toHaveBeenCalledTimes(1)
    })
  })
})
