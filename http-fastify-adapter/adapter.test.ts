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

  describe('Fetch API Response Support', () => {
    it('maps status, headers, and body to fastify reply', async () => {
      @Controller('/fetch')
      class FetchController {
        @Get('/json')
        get() {
          return Response.json({ hello: 'world' }, {
            status: 201,
            headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
          })
        }
      }

      void [FetchController]

      const app = newHTTP(fastifyAdapterFactory(fastify()))
      const adapter = await app.create()
      await adapter.ready()

      const res = await adapter.instance().inject({ method: 'GET', url: '/fetch/json' })

      expect(res.statusCode).toBe(201)
      expect(res.headers['x-custom']).toBe('yes')
      expect(res.json()).toEqual({ hello: 'world' })
    })

    it('handles a no-body Response (204)', async () => {
      @Controller('/fetch')
      class NoBodyController {
        @Get('/empty')
        get() {
          return new Response(null, { status: 204 })
        }
      }

      void [NoBodyController]

      const app = newHTTP(fastifyAdapterFactory(fastify()))
      const adapter = await app.create()
      await adapter.ready()

      const res = await adapter.instance().inject({ method: 'GET', url: '/fetch/empty' })

      expect(res.statusCode).toBe(204)
      expect(res.body).toBe('')
    })

    it('streams a Buffer body', async () => {
      const data = Buffer.from('hello buffer')

      @Controller('/fetch')
      class BufferController {
        @Get('/buf')
        get() {
          return new Response(data, {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          })
        }
      }

      void [BufferController]

      const app = newHTTP(fastifyAdapterFactory(fastify()))
      const adapter = await app.create()
      await adapter.ready()

      const res = await adapter.instance().inject({ method: 'GET', url: '/fetch/buf' })

      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toMatch('application/octet-stream')
      expect(Buffer.from(res.rawPayload)).toEqual(data)
    })

    it('streams a Buffer body with correct byte length', async () => {
      const data = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff])

      @Controller('/fetch')
      class BinaryController {
        @Get('/binary')
        get() {
          return new Response(data, {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          })
        }
      }

      void [BinaryController]

      const app = newHTTP(fastifyAdapterFactory(fastify()))
      const adapter = await app.create()
      await adapter.ready()

      const res = await adapter.instance().inject({ method: 'GET', url: '/fetch/binary' })

      expect(res.statusCode).toBe(200)
      expect(res.rawPayload.length).toBe(5)
      expect(Array.from(res.rawPayload)).toEqual([0x00, 0x01, 0x02, 0x03, 0xff])
    })
  })
})
