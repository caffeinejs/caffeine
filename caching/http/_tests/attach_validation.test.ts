import { CaffeineIoC } from '@caffeinejs/di'
import {
  ErrConfiguration,
  Router,
  constraint,
  constraints,
  createWebApplication,
  version,
  type ConstraintStrategy,
} from '@caffeinejs/http'
import { afterEach, describe, expect, it } from 'vitest'

import { MemoryHTTPCacheStore } from '../../store/memory/index.js'
import { HTTPCaching, cacheControl, type CacheControlOptions } from '../index.js'

// Programmatic routes on a container that reads no decorators: the controller registry is global, and another
// test's controller is not part of what is being refused here.
const newApp = () => createWebApplication({ container: new CaffeineIoC({ decorators: false }) })

describe('what a route may ask of the cache, checked while it registers', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  async function startWith(options: CacheControlOptions) {
    const router = new Router('/attach')
    router
      .get('/data')
      .with(cacheControl(options))
      .handler(() => ({ ok: true }))

    const app = newApp()
      .with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
      .mount(router)
    close = () => app.close()
    await app.ready()

    return app
  }

  // A ttl of 0 used to mean "max-age=0" to the client and "keep forever" to the store.
  it.each([
    ['a ttl of zero', { ttl: 0 }],
    ['a ttl the parser would read as zero', { ttl: '10 seconds' }],
    ['a negative ttl', { ttl: -5 }],
    ['a sharedMaxAge that is not a duration', { ttl: 60, sharedMaxAge: 'an hour' }],
    ['a negative staleIfError', { ttl: 60, staleIfError: -1 }],
    ['a ttl below one second, which max-age cannot say', { ttl: '400ms' }],
    ['an empty tag', { ttl: 60, tags: [''] }],
    ['a tag holding a brace', { ttl: 60, tags: ['pets', '{x}'] }],
    ['tags that are not a list', { ttl: 60, tags: 'pets' as never }],
  ] as [string, CacheControlOptions][])('refuses %s', async (_name, options) => {
    await expect(startWith(options)).rejects.toThrow(ErrConfiguration)
  })

  it('names the route, the option and the value it refused', async () => {
    await expect(startWith({ ttl: '10 seconds' })).rejects.toThrow(
      'Cannot install caching on "GET /attach/data": ttl must be at least one second, such as 60 or "5m", got "10 seconds"',
    )
    await expect(startWith({ ttl: 0.5 })).rejects.toThrow(
      'Cannot install caching on "GET /attach/data": ttl must be at least one second, such as 60 or "5m", got "0.5"',
    )
    await expect(startWith({ ttl: 60, tags: ['a}b'] })).rejects.toThrow(
      'Cannot install caching on "GET /attach/data": a tag must be a non-empty string without "{" or "}", got "a}b"',
    )
  })

  it('takes a route without tags, and one whose tags are an empty list', async () => {
    const app = await startWith({ ttl: 60, tags: [] })

    await app.fetch('/attach/data')

    expect((await app.fetch('/attach/data')).headers.get('x-cache')).toBe('HIT')
  })

  it('takes a sharedMaxAge of zero, which tells shared caches not to keep the response', async () => {
    const app = await startWith({ ttl: 60, sharedMaxAge: 0 })

    expect((await app.fetch('/attach/data')).headers.get('cache-control')).toBe('public, max-age=60, s-maxage=0')
  })

  it('reads the methods a route lists whatever their case', async () => {
    const app = await startWith({ ttl: 60, methods: ['get'] })

    await app.fetch('/attach/data')

    expect((await app.fetch('/attach/data')).headers.get('x-cache')).toBe('HIT')
  })
})

/**
 * Two routes on one URL under different constraints have the same default key, so the second version was served
 * the first one's response. The cache cannot tell them apart on its own; it refuses to guess.
 */
describe('constrained routes that share a URL', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  function versioned(v1: CacheControlOptions, v2: CacheControlOptions) {
    const pets = new Router('/pets-versioned')
    pets
      .get('/')
      .name('v1')
      .with(version('1.0.0'), cacheControl(v1))
      .handler(() => ({ v: 1 }))
    pets
      .get('/')
      .name('v2')
      .with(version('2.0.0'), cacheControl(v2))
      .handler(() => ({ v: 2 }))

    return pets
  }

  async function start(router: Router, cachingFirst = true) {
    const caching = HTTPCaching(b => b.store(new MemoryHTTPCacheStore()))
    const app = cachingFirst
      ? newApp()
          .with(caching)
          .with(() => constraints())
      : newApp()
          .with(() => constraints())
          .with(caching)
    const mounted = app.mount(router)
    close = () => mounted.close()
    await mounted.ready()

    return mounted
  }

  it.each([
    ['caching installed before constraints', true],
    ['caching installed after constraints', false],
  ])('are refused when nothing in the key tells them apart (%s)', async (_name, cachingFirst) => {
    await expect(start(versioned({ ttl: 60 }, { ttl: 60 }), cachingFirst)).rejects.toThrow(
      /constrained on "Accept-Version" and its cache key does not tell it from the other routes/,
    )
  })

  it('never serve one version the other, once they vary on the constraint header', async () => {
    const app = await start(versioned({ ttl: 60, vary: ['Accept-Version'] }, { ttl: 60, vary: ['accept-version'] }))

    const v1 = await app.fetch('/pets-versioned', { headers: { 'accept-version': '1.x' } })
    const v2 = await app.fetch('/pets-versioned', { headers: { 'accept-version': '2.x' } })
    const v2Again = await app.fetch('/pets-versioned', { headers: { 'accept-version': '2.x' } })

    expect(await v1.json()).toEqual({ v: 1 })
    expect(await v2.json()).toEqual({ v: 2 })
    expect(v2Again.headers.get('x-cache')).toBe('HIT')
    expect(await v2Again.json()).toEqual({ v: 2 })
  })

  it('never serve one version the other, once each has a key of its own', async () => {
    const app = await start(
      versioned({ ttl: 60, key: req => `v1:${req.url}` }, { ttl: 60, key: req => `v2:${req.url}` }),
    )

    await app.fetch('/pets-versioned', { headers: { 'accept-version': '1.x' } })
    const v2 = await app.fetch('/pets-versioned', { headers: { 'accept-version': '2.x' } })

    expect(v2.headers.get('x-cache')).toBe('MISS')
    expect(await v2.json()).toEqual({ v: 2 })
  })

  it('start without a ttl, since nothing is stored to collide', async () => {
    await expect(start(versioned({}, {}))).resolves.toBeDefined()
  })

  // A strategy that reads something other than one header leaves the default key nothing to vary on.
  it('are refused when the constraint names no header, until the route keys itself', async () => {
    const tenant: ConstraintStrategy = {
      name: 'tenant',
      mustMatchWhenDerived: false,
      storage() {
        const map = new Map<string, unknown>()
        return { get: value => map.get(value) ?? null, set: (value, handler) => void map.set(value, handler) }
      },
      deriveConstraint: req => req.headers['x-tenant'] as string | undefined,
    }

    const build = (options: CacheControlOptions) => {
      const router = new Router('/tenant-data')
      router
        .get('/')
        .with(constraint('tenant', 'acme'), cacheControl(options))
        .handler(() => ({ tenant: 'acme' }))

      const app = newApp()
        .with(() => constraints([tenant]))
        .with(HTTPCaching(b => b.store(new MemoryHTTPCacheStore())))
        .mount(router)
      close = () => app.close()

      return app.ready()
    }

    await expect(build({ ttl: 60 })).rejects.toThrow(/constraint "tenant" reads no header the cache key can vary on/)
    await close?.()
    // A rejection here fails the test: the key is what lets the same route start.
    await build({ ttl: 60, key: req => `acme:${req.url}` })
  })
})
