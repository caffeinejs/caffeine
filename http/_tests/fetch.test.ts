import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Controller, Get, Header, createWebApplication, fastifyAdapterFactory } from '../index.js'

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

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.instance.inject({ method: 'GET', url: '/fetch/json' })

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

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.instance.inject({ method: 'GET', url: '/fetch/empty' })

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

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.instance.inject({ method: 'GET', url: '/fetch/buf' })

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

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const res = await app.instance.inject({ method: 'GET', url: '/fetch/binary' })

    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.length).toBe(5)
    expect(Array.from(res.rawPayload)).toEqual([0x00, 0x01, 0x02, 0x03, 0xff])
  })

  describe('Mixing with decorator headers', () => {
    it('class @Header and Response headers with different keys are both present', async () => {
      @Header('x-class', 'from-decorator')
      @Controller('/mix-class')
      class MixClassController {
        @Get('/route')
        get() {
          return Response.json({}, { headers: { 'x-response': 'from-response' } })
        }
      }

      void [MixClassController]

      const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
      await app.ready()

      const res = await app.instance.inject({ method: 'GET', url: '/mix-class/route' })

      expect(res.headers['x-class']).toBe('from-decorator')
      expect(res.headers['x-response']).toBe('from-response')
    })

    it('method @Header and Response headers with different keys are both present', async () => {
      @Controller('/mix-method')
      class MixMethodController {
        @Header('x-method', 'from-decorator')
        @Get('/route')
        get() {
          return Response.json({}, { headers: { 'x-response': 'from-response' } })
        }
      }

      void [MixMethodController]

      const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
      await app.ready()

      const res = await app.instance.inject({ method: 'GET', url: '/mix-method/route' })

      expect(res.headers['x-method']).toBe('from-decorator')
      expect(res.headers['x-response']).toBe('from-response')
    })

    it('Response header overrides class @Header with same key', async () => {
      @Header('x-version', 'decorator')
      @Controller('/override-class')
      class OverrideClassController {
        @Get('/route')
        get() {
          return Response.json({}, { headers: { 'x-version': 'response' } })
        }
      }

      void [OverrideClassController]

      const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
      await app.ready()

      const res = await app.instance.inject({ method: 'GET', url: '/override-class/route' })

      expect(res.headers['x-version']).toBe('response')
    })

    it('Response header overrides method @Header with same key', async () => {
      @Controller('/override-method')
      class OverrideMethodController {
        @Header('x-version', 'decorator')
        @Get('/route')
        get() {
          return Response.json({}, { headers: { 'x-version': 'response' } })
        }
      }

      void [OverrideMethodController]

      const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
      await app.ready()

      const res = await app.instance.inject({ method: 'GET', url: '/override-method/route' })

      expect(res.headers['x-version']).toBe('response')
    })
  })
})
