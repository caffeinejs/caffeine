import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Controller, Post, newHTTP, BodyLimit } from '@caffeinejs/http'
import { fastifyAdapterFactory } from '../adapter_factory.js'

describe('BodyLimit', () => {
  it('class-level @BodyLimit rejects bodies exceeding the limit with 413', async () => {
    @BodyLimit(10)
    @Controller('/limited')
    class LimitedController {
      @Post('/data')
      post() {
        return { ok: true }
      }
    }

    void [LimitedController]

    const app = newHTTP(fastifyAdapterFactory(fastify()))
    await app.ready()

    const over = await app.instance.inject({
      method: 'POST',
      url: '/limited/data',
      payload: 'x'.repeat(20),
      headers: { 'content-type': 'text/plain' },
    })

    expect(over.statusCode).toBe(413)
  })

  it('method-level @BodyLimit overrides class-level', async () => {
    @BodyLimit(100)
    @Controller('/mixed-limit')
    class MixedLimitController {
      @Post('/class-limit')
      classLimit() {
        return { ok: true }
      }

      @BodyLimit(10)
      @Post('/route-limit')
      routeLimit() {
        return { ok: true }
      }
    }

    void [MixedLimitController]

    const app = newHTTP(fastifyAdapterFactory(fastify()))
    await app.ready()

    const body = 'x'.repeat(50)
    const headers = { 'content-type': 'text/plain' }

    const classRes = await app.instance.inject({
      method: 'POST',
      url: '/mixed-limit/class-limit',
      payload: body,
      headers,
    })

    const routeRes = await app.instance.inject({
      method: 'POST',
      url: '/mixed-limit/route-limit',
      payload: body,
      headers,
    })

    expect(classRes.statusCode).toBe(200)
    expect(routeRes.statusCode).toBe(413)
  })
})
