import { describe, it, expect } from 'vitest'
import supertest from 'supertest'
import fastify from 'fastify'
import { fastifyAdapter, fastifyAdapterFactory } from './adapter.js'
import { Controller, Get, header, newHTTP, param, Params, query } from '@caffeinejs/http'
import { DiCaf } from '@caffeinejs/core'

describe('Fastify Adapter', () => {
  it('exposes the underlying server as a supertest-compatible listener', async () => {
    const container = new DiCaf()
    const app = fastify()
    app.get('/', () => ({ ok: true }))
    await app.ready()

    const adapter = fastifyAdapter(app, container)
    const adaptee = await Promise.resolve(adapter({ routers: [] }))

    expect(adaptee.instance()).toBe(app)
    await supertest(adaptee.instance().server).get('/').expect(200, { ok: true })
  })

  it('exposes the underlying fastify instance and can be tested with .inject()', async () => {
    const container = new DiCaf()
    const app = fastify()
    app.get('/', () => ({ ok: true }))
    await app.ready()

    const adapter = fastifyAdapter(app, container)
    const adaptee = await Promise.resolve(adapter({ routers: [] }))
    const result = await adaptee.instance().inject('/')

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

      const srv = await newHTTP(fastifyAdapterFactory(fastify()))

      await supertest(srv.instance().server)
        .get('/users/1?filter=test')
        .set('x-test', 'test')
        .expect(200, { ok: true, id: '1', filter: 'test', test: 'test' })
    })
  })
})
