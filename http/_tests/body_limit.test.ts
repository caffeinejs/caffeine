import fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import { Controller, Post, createWebApplication, BodyLimit, fastifyAdapterFactory } from '../index.js'

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

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const over = await app.fetch('/limited/data', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(20),
    })

    expect(over.status).toBe(413)
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

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const body = 'x'.repeat(50)
    const headers = { 'content-type': 'text/plain' }

    const classRes = await app.fetch('/mixed-limit/class-limit', { method: 'POST', headers, body: body })

    const routeRes = await app.fetch('/mixed-limit/route-limit', { method: 'POST', headers, body: body })

    expect(classRes.status).toBe(200)
    expect(routeRes.status).toBe(413)
  })
})
