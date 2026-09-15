import { Injectable, type OnBootstrap, type OnDestroy } from '@caffeinejs/di'
import fastify from 'fastify'
import { describe, it, expect, vi } from 'vitest'

import { Controller, Get, createWebApplication, fastifyAdapterFactory } from '../index.js'

describe('Adapter Lifecycle', () => {
  it('a container OnBootstrap hook runs before the first request is served', async () => {
    const order: string[] = []

    @Injectable()
    class Warmup implements OnBootstrap {
      onBootstrap() {
        order.push('bootstrap')
      }
    }

    @Controller('/lc')
    class LifecycleController {
      @Get('/ping')
      ping() {
        order.push('request')
        return {}
      }
    }

    void [LifecycleController, Warmup]

    const app = createWebApplication(fastifyAdapterFactory(fastify()))

    await app.ready()

    const res = await app.fetch('/lc/ping')

    expect(res.status).toBe(200)
    expect(order).toEqual(['bootstrap', 'request'])
  })

  it('a container OnDestroy hook runs during close()', async () => {
    const closeFired = vi.fn()

    @Injectable()
    class Resource implements OnDestroy {
      onDestroy() {
        closeFired()
      }
    }

    @Controller('/lc3')
    class Lc3Controller {
      @Get('/ping')
      ping() {
        return {}
      }
    }

    void [Lc3Controller, Resource]

    const app = createWebApplication(fastifyAdapterFactory(fastify()))

    await app.ready()
    await app.close()

    expect(closeFired).toHaveBeenCalledOnce()
  })

  it('close() shuts down the Fastify instance', async () => {
    @Controller('/lc4')
    class Lc4Controller {
      @Get('/ping')
      ping() {
        return {}
      }
    }

    void [Lc4Controller]

    const app = createWebApplication(fastifyAdapterFactory(fastify()))
    await app.ready()

    const beforeClose = await app.fetch('/lc4/ping')
    expect(beforeClose.status).toBe(200)

    await app.close()

    await expect(app.fetch('/lc4/ping')).rejects.toThrow()
  })
})
