import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Controller, Get, newHTTP, Timeout } from '@caffeinejs/http'
import { fastifyAdapterFactory } from '../adapter_factory.js'

describe('Timeout', () => {
  it('method-level @Timeout overrides class-level timeout', async () => {
    @Timeout(1)
    @Controller('/timed-class')
    class TimedClassController {
      @Get('/slow')
      async slow() {
        await new Promise(resolve => setTimeout(resolve, 50))
        return { ok: true }
      }

      @Timeout(500)
      @Get('/fast-enough')
      async fastEnough() {
        await new Promise(resolve => setTimeout(resolve, 50))
        return { ok: true }
      }
    }

    void [TimedClassController]

    const app = newHTTP(fastifyAdapterFactory(fastify()))
    await app.ready()

    const slowRes = await app.server().inject({ method: 'GET', url: '/timed-class/slow' })
    const fastRes = await app.server().inject({ method: 'GET', url: '/timed-class/fast-enough' })

    expect(slowRes.statusCode).toBe(503)
    expect(fastRes.statusCode).toBe(200)
  })

  it('method-level @Timeout triggers 503 when handler exceeds the timeout', async () => {
    @Controller('/timed')
    @Timeout(250)
    class TimedController {
      @Timeout(1)
      @Get('/slow')
      async slow() {
        await new Promise(resolve => setTimeout(resolve, 50))
        return { ok: true }
      }
    }

    void [TimedController]

    const app = newHTTP(fastifyAdapterFactory(fastify()))
    await app.ready()

    const res = await app.server().inject({ method: 'GET', url: '/timed/slow' })

    expect(res.statusCode).toBe(503)
  })
})
