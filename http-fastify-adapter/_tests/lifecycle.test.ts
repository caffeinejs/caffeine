import { describe, it, expect, vi } from 'vitest'
import fastify from 'fastify'
import { Controller, Get, newHTTP } from '@caffeinejs/http'
import { fastifyAdapterFactory } from '../adapter_factory.js'

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

    const app = newHTTP(fastifyAdapterFactory(fastify()))
    const adapter = await app.create()

    adapter.onReady(async () => {
      order.push('ready-hook')
    })

    await adapter.ready()

    const res = await adapter.instance().inject({ method: 'GET', url: '/lc/ping' })

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

    const app = newHTTP(fastifyAdapterFactory(fastify()))
    const adapter = await app.create()

    const order: number[] = []
    adapter
      .onReady(async () => { order.push(1) })
      .onReady(async () => { order.push(2) })
      .onReady(async () => { order.push(3) })

    await adapter.ready()

    expect(order).toEqual([1, 2, 3])
  })

  it('onClose hook fires during close()', async () => {
    @Controller('/lc3')
    class Lc3Controller {
      @Get('/ping')
      ping() { return {} }
    }

    void [Lc3Controller]

    const app = newHTTP(fastifyAdapterFactory(fastify()))
    const adapter = await app.create()

    const closeFired = vi.fn()
    adapter.onClose(async () => {
      closeFired()
    })

    await adapter.ready()
    await adapter.close()

    expect(closeFired).toHaveBeenCalledOnce()
  })

  it('close() shuts down the Fastify instance', async () => {
    @Controller('/lc4')
    class Lc4Controller {
      @Get('/ping')
      ping() { return {} }
    }

    void [Lc4Controller]

    const app = newHTTP(fastifyAdapterFactory(fastify()))
    const adapter = await app.create()

    await adapter.ready()

    const beforeClose = await adapter.instance().inject({ method: 'GET', url: '/lc4/ping' })
    expect(beforeClose.statusCode).toBe(200)

    await adapter.close()

    await expect(
      adapter.instance().inject({ method: 'GET', url: '/lc4/ping' }),
    ).rejects.toThrow()
  })
})
