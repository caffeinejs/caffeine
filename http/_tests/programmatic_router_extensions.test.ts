import { describe, expect, it } from 'vitest'
import fastify from 'fastify'
import fastifyCompress from '@fastify/compress'
import { $t } from '@caffeinejs/std'
import {
  Args,
  BodyAsStream,
  Controller,
  Post,
  Router,
  bodyAsBuffer,
  bodyAsStream,
  compress,
  createWebApplication,
  encoding,
  fastifyAdapterFactory,
  fst,
  type RouteExtension,
} from '../index.js'
import { RouteBuilder, RouteGroupBuilder } from '../routing/builder.js'
import { kBodyBuffer } from '../decorators/keys/keys.js'
import { $p } from '../route_picker.js'

const kMark = Symbol('test.mark')

describe('route extensions', () => {
  describe('given a body-reading extension', () => {
    it('should deliver the body the way its decorator does', async () => {
      const router = new Router('/ext-stream')
      router
        .post('/upload')
        .with(bodyAsStream())
        .handler(async ctx => {
          const stream = ctx.req.body() as ReadableStream
          const chunks: Uint8Array[] = []
          for await (const chunk of stream) {
            chunks.push(chunk)
          }
          return { isStream: stream instanceof ReadableStream, size: chunks.reduce((n, c) => n + c.byteLength, 0) }
        })

      @Controller('/dec-stream')
      class DecoratedStreamController {
        @BodyAsStream()
        @Post('/upload')
        @Args([$p.body()])
        async upload(stream: ReadableStream) {
          const chunks: Uint8Array[] = []
          for await (const chunk of stream) {
            chunks.push(chunk)
          }
          return { isStream: stream instanceof ReadableStream, size: chunks.reduce((n, c) => n + c.byteLength, 0) }
        }
      }
      void [DecoratedStreamController]

      const app = createWebApplication(fastifyAdapterFactory(fastify())).build().mount(router)
      await app.ready()

      const payload = Buffer.from('hello stream world')
      const send = (path: string) =>
        app.fetch(path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: payload })

      const expected = { isStream: true, size: payload.byteLength }
      expect(await (await send('/ext-stream/upload')).json()).toEqual(expected)
      expect(await (await send('/dec-stream/upload')).json()).toEqual(expected)

      await app.close()
    })

    it('should read the body as a buffer', async () => {
      const router = new Router('/ext-buffer')
      router
        .post('/upload')
        .with(bodyAsBuffer())
        .handler(ctx => {
          const body = ctx.req.body() as Buffer
          return { isBuffer: Buffer.isBuffer(body), text: body.toString() }
        })

      const app = createWebApplication(fastifyAdapterFactory(fastify())).build().mount(router)
      await app.ready()

      const res = await app.fetch('/ext-buffer/upload', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'raw bytes',
      })

      expect(await res.json()).toEqual({ isBuffer: true, text: 'raw bytes' })

      await app.close()
    })
  })

  describe('given an extension applied at group level', () => {
    it('should reach every route of the group', async () => {
      const server = fastify()
      await server.register(fastifyCompress, { global: true })

      const router = new Router('/ext-compress').with(compress(false))
      router.get('/a').handler(() => ({ message: 'hello world'.repeat(100) }))
      router.get('/b').handler(() => ({ message: 'hello world'.repeat(100) }))

      const compressed = new Router('/ext-compressed')
      compressed.get('/a').handler(() => ({ message: 'hello world'.repeat(100) }))

      const app = createWebApplication(fastifyAdapterFactory(server)).build().mount(router, compressed)
      await app.ready()

      const headers = { 'accept-encoding': 'br, gzip, deflate' }

      expect((await app.fetch('/ext-compress/a', { headers })).headers.get('content-encoding')).toBeNull()
      expect((await app.fetch('/ext-compress/b', { headers })).headers.get('content-encoding')).toBeNull()
      expect((await app.fetch('/ext-compressed/a', { headers })).headers.get('content-encoding'))
        .toMatch(/br|gzip|deflate/)

      await app.close()
    })
  })

  describe('given several extensions in one call', () => {
    it('should apply them in argument order', () => {
      const seen: string[] = []
      const mark = (tag: string): RouteExtension => route => {
        seen.push(tag)
        route.extras(kMark, tag)
      }

      const router = new Router('/order')
      router.get('/').with(mark('first'), mark('second'), mark('third')).handler(() => null)

      expect(seen).toEqual(['first', 'second', 'third'])
    })
  })

  describe('given a decorator and its extension', () => {
    it('should write the same spec', () => {
      const viaExtension = new RouteBuilder()
      compress(false)(viaExtension)
      encoding('gzip')(viaExtension)
      bodyAsBuffer()(viaExtension)

      const viaDecoratorEquivalent = new RouteBuilder()
      viaDecoratorEquivalent.options('compress', false)
      viaDecoratorEquivalent.options('decompress', { requestEncodings: ['gzip'] })
      viaDecoratorEquivalent.extras(kBodyBuffer, true)

      const a = viaExtension.toRoute()
      const b = viaDecoratorEquivalent.toRoute()

      expect(a.options).toEqual(b.options)
      expect(a.extras).toEqual(b.extras)
    })

    it('should apply at group level too', () => {
      const group = new RouteGroupBuilder()
      compress({ threshold: 1024 })(group)

      expect(group.toRouteGroup().options?.get('compress')).toEqual({ threshold: 1024 })
    })
  })
})

describe('fst', () => {
  describe('given a lifecycle hook', () => {
    it('should run it, ahead of the hooks the adapter attaches', async () => {
      const order: string[] = []

      const router = new Router('/fst')
      router
        .get('/hooked')
        .with(fst({
          onRequest: (_req, _res, done) => {
            order.push('fst')
            done()
          },
        }))
        .handler(() => {
          order.push('handler')
          return { ok: true }
        })

      const app = createWebApplication(fastifyAdapterFactory(fastify())).build().mount(router)
      await app.ready()

      expect((await app.fetch('/fst/hooked')).status).toBe(200)
      expect(order).toEqual(['fst', 'handler'])

      await app.close()
    })
  })

  describe('given a route option the router does not own', () => {
    it('should pass it to the adapter', async () => {
      const router = new Router('/fst-opts')
      router
        .get('/validated')
        .with(fst({ attachValidation: true }))
        .schema({ querystring: $t.Object({ n: $t.Integer() }) })
        .handler(ctx => {
          const { validationError } = ctx.reply.request as { validationError?: unknown }
          return { invalid: validationError !== undefined }
        })

      const app = createWebApplication(fastifyAdapterFactory(fastify())).build().mount(router)
      await app.ready()

      // attachValidation turns a validation failure into a flag on the request instead of a 400.
      const res = await app.fetch('/fst-opts/validated?n=nope')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ invalid: true })

      await app.close()
    })
  })
})
