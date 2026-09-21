import { CaffeineIoC } from '@caffeinejs/di'
import { Controller, ErrConfiguration, Get, createWebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryCache } from '../../store/memory/index.js'
import { CacheControl, HTTPCaching } from '../index.js'
import type { CacheMissEvent, CacheObserver } from '../observer.js'

class MissCounter implements CacheObserver {
  readonly misses: CacheMissEvent[] = []

  onMiss(event: CacheMissEvent): void {
    this.misses.push(event)
  }
}

describe('HTTPCaching observer option', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('resolves a container-bound observer passed as a token', async () => {
    @Controller('/obs-opt-token')
    class TokenController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [TokenController]

    const container = new CaffeineIoC()
    container.bind(MissCounter, t => t.toClass(MissCounter))

    const app = createWebApplication({ container }).with(
      HTTPCaching(b => b.store(new MemoryCache()).observer(MissCounter)),
    )
    close = () => app.close()
    await app.ready()

    await app.fetch('/obs-opt-token/data')

    expect((app.container.get(MissCounter) as MissCounter).misses).toHaveLength(1)
  })

  // Unlike `etagGenerator`, there is no default to fall back to: carrying on without the observer someone named
  // would only show up later, as a dashboard that stays empty.
  it('refuses to start when the observer token resolves to nothing', async () => {
    class UnboundObserver implements CacheObserver {
      onMiss(): void {}
    }

    const app = createWebApplication({ container: new CaffeineIoC() }).with(
      HTTPCaching(b => b.store(new MemoryCache()).observer(UnboundObserver)),
    )
    close = () => app.close()

    const failure = app.ready()

    await expect(failure).rejects.toThrow(ErrConfiguration)
    await expect(failure).rejects.toThrow(
      'Cannot install HTTP caching: no binding registered for the given observer token',
    )
  })

  it('takes an observer from the plain options object too', async () => {
    @Controller('/obs-opt-object')
    class ObjectController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [ObjectController]

    const observer = new MissCounter()
    const app = createWebApplication().with(HTTPCaching({ store: new MemoryCache(), observer }))
    close = () => app.close()
    await app.ready()

    await app.fetch('/obs-opt-object/data')

    expect(observer.misses).toHaveLength(1)
  })
})
