import { CaffeineIoC, token } from '@caffeinejs/di'
import { Controller, ErrConfiguration, Get, createWebApplication } from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import type { Cache } from '../../store.js'
import { MemoryCache } from '../../store/memory/index.js'
import { CacheControl, HTTPCaching, kETagGenerator } from '../index.js'

describe('caching is opt-in', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  it('does nothing to an undecorated application that never installs the plugin', async () => {
    @Controller('/optin-plain')
    class PlainController {
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [PlainController]

    const app = createWebApplication()
    close = () => app.close()
    await app.ready()

    const res = await app.fetch('/optin-plain/data')
    expect(res.headers.get('x-cache')).toBeNull()
  })

  it('fails at ready() when a route is decorated but the plugin is not installed', async () => {
    @Controller('/optin-missing')
    class MissingController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [MissingController]

    const app = createWebApplication()
    close = () => app.close()

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })

  // A generator someone named and forgot to bind is a mistake, not a request for the default one.
  it('throws ErrConfiguration when the etagGenerator token resolves to nothing', async () => {
    const app = createWebApplication().with(HTTPCaching(b => b.store(new MemoryCache()).etagGenerator(kETagGenerator)))
    close = () => app.close()

    await expect(app.ready()).rejects.toThrow(
      'Cannot install HTTP caching: no binding registered for the given etagGenerator token',
    )
  })

  // A token someone named and bound nothing to is a mistake to surface, not a reason to run without a store.
  it('throws ErrConfiguration when the store token resolves to nothing', async () => {
    const kStore = token<Cache>(Symbol('optin.unbound-store'))
    const app = createWebApplication().with(HTTPCaching(b => b.store(kStore)))
    close = () => app.close()

    await expect(app.ready()).rejects.toThrow(
      'Cannot install HTTP caching: no binding registered for the given store token',
    )
  })

  it('throws ErrConfiguration when installed with no store option', async () => {
    @Controller('/optin-default')
    class DefaultController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [DefaultController]

    const app = createWebApplication({}).with(HTTPCaching())
    close = () => app.close()

    await expect(app.ready()).rejects.toThrow(ErrConfiguration)
  })

  it('resolves a container-bound store passed as a token', async () => {
    class MapStore implements Cache {
      readonly ops: string[] = []
      async get() {
        this.ops.push('get')
        return undefined
      }
      async getMany(keys: string[]) {
        return Promise.all(keys.map(() => this.get()))
      }
      async put() {
        this.ops.push('put')
      }
      async putMany(items: unknown[]) {
        for (const _ of items) {
          await this.put()
        }
      }
      async delete() {}
      async deleteMany() {}
      async clear() {}
    }

    @Controller('/optin-token-store')
    class TokenStoreController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [TokenStoreController]

    const container = new CaffeineIoC()
    container.bind(MapStore, t => t.toClass(MapStore))

    const app = createWebApplication({ container }).with(HTTPCaching(b => b.store(MapStore)))
    close = () => app.close()
    await app.ready()

    await app.fetch('/optin-token-store/data')

    const store = app.container.get(MapStore) as MapStore
    expect(store.ops).toContain('put')
  })

  it('honors .statusHeader(...)', async () => {
    @Controller('/optin-header')
    class HeaderController {
      @CacheControl({ ttl: 60 })
      @Get('/data')
      data() {
        return { ok: true }
      }
    }
    void [HeaderController]

    const app = createWebApplication({}).with(HTTPCaching(b => b.store(new MemoryCache()).statusHeader('X-Edge')))
    close = () => app.close()
    await app.ready()

    const res = await app.fetch('/optin-header/data')
    expect(res.headers.get('x-edge')).toBe('MISS')
    expect(res.headers.get('x-cache')).toBeNull()
  })
})
