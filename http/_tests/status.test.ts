import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Controller, Get, Post, Status, createWebApplication, fastifyAdapterFactory } from '../index.js'

describe('Status', () => {
  it('returns the custom status code set by @Status', async () => {
    @Controller('/status')
    class StatusController {
      @Status(201)
      @Post('/created')
      create() {
        return { ok: true }
      }
    }

    void [StatusController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.instance.inject({ method: 'POST', url: '/status/created' })

    expect(res.statusCode).toBe(201)
  })

  it('leaves status code to Fastify when @Status is not set', async () => {
    @Controller('/status-default')
    class StatusDefaultController {
      @Get('/ok')
      get() {
        return { ok: true }
      }
    }

    void [StatusDefaultController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.instance.inject({ method: 'GET', url: '/status-default/ok' })

    expect(res.statusCode).toBe(200)
  })
})
