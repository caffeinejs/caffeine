import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Controller, Get, Prefix, createWebApplication } from '@caffeinejs/application'
import { fastifyAdapterFactory } from '../adapter_factory.js'

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

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const hit = await app.instance.inject({ method: 'GET', url: '/v1/users/list' })
    const miss = await app.instance.inject({ method: 'GET', url: '/users/list' })

    expect(hit.statusCode).toBe(200)
    expect(miss.statusCode).toBe(404)
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

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const v1 = await app.instance.inject({ method: 'GET', url: '/v1/items/all' })
    const v2 = await app.instance.inject({ method: 'GET', url: '/v2/items/all' })

    expect(v1.statusCode).toBe(200)
    expect(v2.statusCode).toBe(200)
  })
})
