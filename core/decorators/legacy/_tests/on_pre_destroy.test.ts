import 'reflect-metadata'
import { describe, it, expect, vi } from 'vitest'
import { v4 } from 'uuid'
import { OnPreDestroy } from '../on_pre_destroy.js'
import { Configuration } from '../configuration.js'
import { Provides } from '../provides.js'
import { Lazy } from '../lazy.js'
import { DiCaf } from '../../../container.js'

describe('Legacy @OnPreDestroy', function () {
  it('should call the fn with the produced instance on dispose', async function () {
    const spy = vi.fn()

    class ConnLegOPD {
      readonly id = v4()
    }

    @Configuration()
    class AppConfigLegOPD {
      @OnPreDestroy((c: ConnLegOPD) => spy(c))
      @Provides(ConnLegOPD)
      conn(): ConnLegOPD {
        return new ConnLegOPD()
      }
    }

    void AppConfigLegOPD

    const di = new DiCaf()
    await di.init()

    const instance = di.get(ConnLegOPD)
    await di.dispose()

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(instance)
  })

  it('should await an async fn on dispose', async function () {
    const order: string[] = []

    class CacheLegOPD {
      readonly id = v4()
    }

    @Configuration()
    class CacheConfigLegOPD {
      @OnPreDestroy(async (_c: CacheLegOPD) => {
        await Promise.resolve()
        order.push('destroyed')
      })
      @Provides(CacheLegOPD)
      cache(): CacheLegOPD {
        return new CacheLegOPD()
      }
    }

    void CacheConfigLegOPD

    const di = new DiCaf()
    await di.init()

    di.get(CacheLegOPD)
    await di.dispose()

    expect(order).toEqual(['destroyed'])
  })

  it('throws when @OnPreDestroy applied at class level (no propertyKey)', function () {
    expect(() => {
      OnPreDestroy(() => {})(class Target {}, undefined as any, undefined as any)
    }).toThrow()
  })

  it('should not call fn when the instance was never resolved (lazy, not cached)', async function () {
    const spy = vi.fn()

    class SvcLegOPD {}

    @Configuration()
    class SvcConfigLegOPD {
      @Lazy()
      @OnPreDestroy((_s: SvcLegOPD) => spy(_s))
      @Provides(SvcLegOPD)
      svc(): SvcLegOPD {
        return new SvcLegOPD()
      }
    }

    void SvcConfigLegOPD

    const di = new DiCaf()
    await di.init()

    // Never call di.get(SvcLegOPD) → lazy bean never instantiated → not cached
    await di.dispose()

    expect(spy).not.toHaveBeenCalled()
  })
})
