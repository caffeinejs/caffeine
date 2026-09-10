import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { Router, createWebApplication } from '../index.js'

/**
 * Version is a routing key: the request must select one of two same-URL handlers *before* a handler runs.
 * These lock the contract — semver `Accept-Version`, prefer-versioned, 404 on a miss, no invented default —
 * so a change to how the constraint is compiled or handed to Fastify fails here rather than in production
 * routing. Decorated-controller coverage is in `versioning_decorated.test.ts` (kept apart for registry
 * isolation).
 */
describe('API versioning', () => {
  const petsV1AndV2 = () => {
    const v1 = new Router('/pets').name('PetsV1').version('1.0.0')
    v1.get('/').handler(() => ({ v: 1 }))
    const v2 = new Router('/pets').name('PetsV2').version('2.0.0')
    v2.get('/').handler(() => ({ v: 2 }))
    return createWebApplication({ container: new CaffeineIoC() }).build().mount(v1, v2)
  }

  it('routes Accept-Version 1.x to v1 and 2.x to v2, not by registration order', async () => {
    const app = petsV1AndV2()
    await app.ready()

    expect(await (await app.fetch('/pets', { headers: { 'accept-version': '1.x' } })).json()).toEqual({ v: 1 })
    expect(await (await app.fetch('/pets', { headers: { 'accept-version': '2.x' } })).json()).toEqual({ v: 2 })

    await app.close()
  })

  it('404s a request that sends no Accept-Version — no default version is invented', async () => {
    const app = petsV1AndV2()
    await app.ready()

    expect((await app.fetch('/pets')).status).toBe(404)

    await app.close()
  })

  it('sets Vary: Accept-Version on a versioned response, and nothing when no route is constrained', async () => {
    const app = petsV1AndV2()
    await app.ready()
    const versioned = await app.fetch('/pets', { headers: { 'accept-version': '1.x' } })
    expect(versioned.headers.get('vary')?.toLowerCase()).toContain('accept-version')
    await app.close()

    const plain = new Router('/plain').name('Plain')
    plain.get('/').handler(() => ({ ok: true }))
    const plainApp = createWebApplication({ container: new CaffeineIoC() }).build().mount(plain)
    await plainApp.ready()
    const res = await plainApp.fetch('/plain')
    expect(res.headers.get('vary')?.toLowerCase() ?? '').not.toContain('accept-version')
    await plainApp.close()
  })

  it('prefers the versioned twin when the header is present, the unversioned one when it is absent', async () => {
    const plain = new Router('/shop').name('ShopPlain')
    plain.get('/').handler(() => ({ kind: 'plain' }))
    const versioned = new Router('/shop').name('ShopVersioned').version('1.0.0')
    versioned.get('/').handler(() => ({ kind: 'versioned' }))

    const app = createWebApplication({ container: new CaffeineIoC() }).build().mount(plain, versioned)
    await app.ready()

    expect(await (await app.fetch('/shop', { headers: { 'accept-version': '1.x' } })).json()).toEqual({
      kind: 'versioned',
    })
    expect(await (await app.fetch('/shop')).json()).toEqual({ kind: 'plain' })

    await app.close()
  })

  it('fails at ready() when two routes share method, path and version', async () => {
    const a = new Router('/dup').name('DupA').version('1.0.0')
    a.get('/').handler(() => ({}))
    const b = new Router('/dup').name('DupB').version('1.0.0')
    b.get('/').handler(() => ({}))

    const app = createWebApplication({ container: new CaffeineIoC() }).build().mount(a, b)
    await expect(app.ready()).rejects.toThrow()

    await app.close()
  })

  it('leaves a server-owned path reachable without Accept-Version when routes are versioned', async () => {
    const v1 = new Router('/inventory').name('InventoryV1').version('1.0.0')
    v1.get('/').handler(() => ({ v: 1 }))

    const app = createWebApplication({ container: new CaffeineIoC() }).health().build().mount(v1)
    await app.ready()

    expect((await app.fetch('/livez')).status).toBe(200)

    await app.close()
  })
})
