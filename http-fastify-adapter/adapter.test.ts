import { describe, it, expect } from 'vitest'
import supertest from 'supertest'
import fastify from 'fastify'
import { Controller, Get, header, newHTTP, param, Params, query } from '@caffeinejs/http'
import { DiCaf } from '@caffeinejs/core'
import { FastifyAdapter, fastifyAdapterFactory } from './adapter.js'

describe('Fastify Adapter', () => {
  it('exposes the underlying server as a supertest-compatible listener', async () => {
    const app = fastify()
    app.get('/', () => ({ ok: true }))

    const adapter = new FastifyAdapter(new DiCaf(), app, [])
    await adapter.ready()

    expect(adapter.instance()).toBe(app)
    await supertest(adapter.instance().server).get('/')
      .expect(200, { ok: true })
  })

  it('exposes the underlying fastify instance and can be tested with .inject()', async () => {
    const app = fastify()
    app.get('/', () => ({ ok: true }))

    const adapter = new FastifyAdapter(new DiCaf(), app, [])
    await adapter.ready()
    const result = await adapter.instance().inject('/')

    expect(result.json()).toEqual({ ok: true })
  })

  describe('when a controller is decorated with @Get', () => {
    it('should register the route in the fastify instance', async () => {
      @Controller('/users')
      class TestController {
        @Get('/:id')
        @Params([param('id'), query('filter'), header('x-test')])
        async get(id: string, filter: string, test: string) {
          return { ok: true, id, filter, test }
        }
      }

      const app = newHTTP(fastifyAdapterFactory(fastify()))
      const adapter = await app.create()

      await adapter.ready()

      await supertest(adapter.instance().server)
        .get('/users/1?filter=test')
        .set('x-test', 'test')
        .expect(200, { ok: true, id: '1', filter: 'test', test: 'test' })
    })
  })
})
