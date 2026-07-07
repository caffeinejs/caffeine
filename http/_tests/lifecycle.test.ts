import { describe, it, expect, vi } from 'vitest'
import fastify from 'fastify'
import { Controller, Get, createWebApplication, fastifyAdapterFactory } from '../index.js'

describe('Adapter Lifecycle', () => {
  it('onReady hook fires after routes are registered', async () => {
    const order: string[] = []

    @Controller('/lc')
    class LifecycleController {
      @Get('/ping')
      ping() {
        order.push('request')
        return {}
      }
    }

    void [LifecycleController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()

    app.onReady(async () => {
      order.push('ready-hook')
    })

    await app.ready()

    const res = await app.instance.inject({ method: 'GET', url: '/lc/ping' })

    expect(res.statusCode).toBe(200)
    expect(order).toEqual(['ready-hook', 'request'])
  })

  it('multiple onReady hooks fire in registration order', async () => {
    @Controller('/lc2')
    class Lc2Controller {
      @Get('/ping')
      ping() { return {} }
    }

    void [Lc2Controller]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()

    const order: number[] = []
    app
      .onReady(async () => { order.push(1) })
      .onReady(async () => { order.push(2) })
      .onReady(async () => { order.push(3) })

    await app.ready()

    expect(order).toEqual([1, 2, 3])
  })

  it('onClose hook fires during close()', async () => {
    @Controller('/lc3')
    class Lc3Controller {
      @Get('/ping')
      ping() { return {} }
    }

    void [Lc3Controller]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()

    const closeFired = vi.fn()
    app.onClose(async () => {
      closeFired()
    })

    await app.ready()
    await app.close()

    expect(closeFired).toHaveBeenCalledOnce()
  })

  it('close() shuts down the Fastify instance', async () => {
    @Controller('/lc4')
    class Lc4Controller {
      @Get('/ping')
      ping() { return {} }
    }

    void [Lc4Controller]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const beforeClose = await app.instance.inject({ method: 'GET', url: '/lc4/ping' })
    expect(beforeClose.statusCode).toBe(200)

    await app.close()

    await expect(
      app.instance.inject({ method: 'GET', url: '/lc4/ping' }),
    ).rejects.toThrow()
  })
})
