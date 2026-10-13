import { describe, it, expect } from 'vitest'

import { Controller, Get, Header, Router, createWebApplication } from '../index.js'

describe('Fetch API Response Support', () => {
  it('maps status, headers, and body to fastify reply', async () => {
    @Controller('/fetch')
    class FetchController {
      @Get('/json')
      get() {
        return Response.json(
          { hello: 'world' },
          {
            status: 201,
            headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
          },
        )
      }
    }

    void [FetchController]

    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.fetch('/fetch/json')

    expect(res.status).toBe(201)
    expect(res.headers.get('x-custom')).toBe('yes')
    expect(await res.json()).toEqual({ hello: 'world' })
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

    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.fetch('/fetch/empty')

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
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

    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.fetch('/fetch/buf')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch('application/octet-stream')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(data)
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

    const app = createWebApplication()
    await app.bootstrap()

    const res = await app.fetch('/fetch/binary')

    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes.length).toBe(5)
    expect(Array.from(bytes)).toEqual([0x00, 0x01, 0x02, 0x03, 0xff])
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

      const app = createWebApplication()
      await app.bootstrap()

      const res = await app.fetch('/mix-class/route')

      expect(res.headers.get('x-class')).toBe('from-decorator')
      expect(res.headers.get('x-response')).toBe('from-response')
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

      const app = createWebApplication()
      await app.bootstrap()

      const res = await app.fetch('/mix-method/route')

      expect(res.headers.get('x-method')).toBe('from-decorator')
      expect(res.headers.get('x-response')).toBe('from-response')
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

      const app = createWebApplication()
      await app.bootstrap()

      const res = await app.fetch('/override-class/route')

      expect(res.headers.get('x-version')).toBe('response')
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

      const app = createWebApplication()
      await app.bootstrap()

      const res = await app.fetch('/override-method/route')

      expect(res.headers.get('x-version')).toBe('response')
    })
  })

  // What a Fetch client holds is often a `Request` already: its method and headers reach the route as they are.
  it('takes a Request object as well as a path', async () => {
    const app = createWebApplication().mount(
      new Router('/fetch-request').post('/', ctx => ({ probe: ctx.req.header('x-probe') })),
    )

    try {
      await app.bootstrap()

      const res = await app.fetch(
        new Request('http://localhost/fetch-request', { method: 'POST', headers: { 'x-probe': 'yes' } }),
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ probe: 'yes' })
    } finally {
      await app.close()
    }
  })

  // An absolute URL, as a `URL` or as a string, reaches the route with the host and query it names.
  it('takes a URL, or an absolute URL string, as well as a path', async () => {
    const app = createWebApplication().mount(
      new Router('/fetch-url').get('/', ctx => ({ host: ctx.req.host, q: ctx.req.query('q') })),
    )

    try {
      await app.bootstrap()

      expect(await (await app.fetch(new URL('http://api.example:8080/fetch-url?q=1'))).json()).toEqual({
        host: 'api.example:8080',
        q: '1',
      })
      expect(await (await app.fetch('http://api.example:8080/fetch-url?q=2')).json()).toEqual({
        host: 'api.example:8080',
        q: '2',
      })
    } finally {
      await app.close()
    }
  })

  // A 1xx answer has no `Response` form. The call rejects rather than never settling.
  it('rejects an informational answer it cannot hand back as a Response', async () => {
    const app = createWebApplication().serverCallback((_context, instance) => {
      instance.get('/fetch-early', (_request, reply) => {
        void reply.code(101).send()
      })
    })

    try {
      await app.bootstrap()

      await expect(app.fetch('/fetch-early')).rejects.toThrow(RangeError)
    } finally {
      await app.close()
    }
  })
})
