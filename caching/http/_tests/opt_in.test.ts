import { token } from '@caffeinejs/di'
import { Controller, ErrConfiguration, Get } from '@caffeinejs/http'
import { createWebApplication } from '@caffeinejs/http/fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import { CacheControl, HTTPCaching, kETagGenerator, type HTTPCacheStore } from '../index.js'

describe('caching is opt-in', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  // The package is loaded by this file. Loading it registers nothing anywhere: until the plugin is installed, an
  // application answers exactly as it would without it.
  it('leaves an application that never installs the plugin as it was, though the package is loaded', async () => {
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
    await app.bootstrap()

    const res = await app.fetch('/optin-plain/data')
    expect(res.headers.get('x-cache')).toBeNull()
  })

  it('fails at bootstrap() when a route is decorated but the plugin is not installed', async () => {
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

    await expect(app.bootstrap()).rejects.toThrow(ErrConfiguration)
  })

  // A generator someone named and forgot to bind is a mistake, not a request for the default one.
  it('throws ErrConfiguration when the etagGenerator token resolves to nothing', async () => {
    const app = createWebApplication().with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).etagGenerator(kETagGenerator)),
    )
    close = () => app.close()

    await expect(app.bootstrap()).rejects.toThrow(
      'Cannot install HTTP caching: no binding registered for the given etagGenerator token',
    )
  })

  // A token someone named and bound nothing to is a mistake to surface, not a reason to run without a store.
  it('throws ErrConfiguration when the store token resolves to nothing', async () => {
    const kStore = token<HTTPCacheStore>(Symbol('optin.unbound-store'))
    const app = createWebApplication().with(HTTPCaching(b => b.store(kStore)))
    close = () => app.close()

    await expect(app.bootstrap()).rejects.toThrow(
      'Cannot install HTTP caching: no binding registered for the given store token',
    )
  })

  // There is no default store to fall back to, whichever way the install is written.
  it.each([
    ['no options', () => HTTPCaching()],
    ['a builder that names no store', () => HTTPCaching(b => b.statusHeader('X-Cache'))],
  ])('throws ErrConfiguration when installed with %s', async (_form, install) => {
    const app = createWebApplication({}).with(install())
    close = () => app.close()

    const booting = app.bootstrap()

    await expect(booting).rejects.toThrow(ErrConfiguration)
    await expect(booting).rejects.toThrow('Cannot install HTTP caching without a store')
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

    const app = createWebApplication({}).with(
      HTTPCaching(b => b.store(new MemoryHTTPCacheStore()).statusHeader('X-Edge')),
    )
    close = () => app.close()
    await app.bootstrap()

    const res = await app.fetch('/optin-header/data')
    expect(res.headers.get('x-edge')).toBe('MISS')
    expect(res.headers.get('x-cache')).toBeNull()
  })
})
