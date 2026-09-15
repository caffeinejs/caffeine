import { CaffeineIoC } from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { Controller, Get, Prefix, Version, createWebApplication } from '../index.js'

/**
 * `@Version` on a decorated controller must compile to the same Fastify `version` constraint a programmatic
 * `.version()` does. Kept in its own file: `@Controller` registers into a module-global registry that every
 * later `new CaffeineIoC()` snapshots, so a decorated `/pets` here would collide with a programmatic `/pets`
 * in a shared file.
 */
describe('API versioning — decorated controllers', () => {
  it('selects the handler by Accept-Version with a class-level @Version', async () => {
    @Controller('/pets')
    @Version('1.0.0')
    class PetsV1 {
      @Get('/')
      list() {
        return { v: 1 }
      }
    }

    @Controller('/pets')
    @Version('2.0.0')
    class PetsV2 {
      @Get('/')
      list() {
        return { v: 2 }
      }
    }

    const container = new CaffeineIoC()
    container.bind(PetsV1, t => t.toSelf())
    container.bind(PetsV2, t => t.toSelf())
    const app = createWebApplication({ container })
    await app.ready()

    expect(await (await app.fetch('/pets', { headers: { 'accept-version': '1.x' } })).json()).toEqual({ v: 1 })
    expect(await (await app.fetch('/pets', { headers: { 'accept-version': '2.x' } })).json()).toEqual({ v: 2 })
    expect((await app.fetch('/pets')).status).toBe(404)

    await app.close()
  })

  it('a method-level @Version overrides the class-level one', async () => {
    @Controller('/catalog')
    @Version('1.0.0')
    class Catalog {
      @Get('/item')
      item() {
        return { at: 1 }
      }

      @Get('/item')
      @Version('2.0.0')
      itemV2() {
        return { at: 2 }
      }
    }

    const container = new CaffeineIoC()
    container.bind(Catalog, t => t.toSelf())
    const app = createWebApplication({ container })
    await app.ready()

    expect(await (await app.fetch('/catalog/item', { headers: { 'accept-version': '1.x' } })).json()).toEqual({ at: 1 })
    expect(await (await app.fetch('/catalog/item', { headers: { 'accept-version': '2.x' } })).json()).toEqual({ at: 2 })

    await app.close()
  })

  it('@Prefix is URI versioning and stays unconstrained — /v1/pets answers with no Accept-Version', async () => {
    @Prefix('/v1')
    @Controller('/pets')
    class V1Pets {
      @Get('/')
      list() {
        return { prefixed: true }
      }
    }

    const container = new CaffeineIoC()
    container.bind(V1Pets, t => t.toSelf())
    const app = createWebApplication({ container })
    await app.ready()

    expect(await (await app.fetch('/v1/pets')).json()).toEqual({ prefixed: true })

    await app.close()
  })
})
