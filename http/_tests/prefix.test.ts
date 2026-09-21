import { describe, it, expect } from 'vitest'

import { Controller, Get, Prefix, createWebApplication } from '../index.js'

describe('Prefix', () => {
  it('prepends prefix to all routes in the controller', async () => {
    @Prefix('/v1')
    @Controller('/users')
    class UsersController {
      @Get('/list')
      list() {
        return { ok: true }
      }
    }

    void [UsersController]

    const app = createWebApplication()
    await app.ready()

    const hit = await app.fetch('/v1/users/list')
    const miss = await app.fetch('/users/list')

    expect(hit.status).toBe(200)
    expect(miss.status).toBe(404)
  })

  it('each controller gets its own independent prefix', async () => {
    @Prefix('/v1')
    @Controller('/items')
    class ItemsController {
      @Get('/all')
      all() {
        return { items: true }
      }
    }

    @Prefix('/v2')
    @Controller('/items')
    class ItemsV2Controller {
      @Get('/all')
      all() {
        return { items: true, v2: true }
      }
    }

    void [ItemsController, ItemsV2Controller]

    const app = createWebApplication()
    await app.ready()

    const v1 = await app.fetch('/v1/items/all')
    const v2 = await app.fetch('/v2/items/all')

    expect(v1.status).toBe(200)
    expect(v2.status).toBe(200)
  })
})
