import { $t } from '@caffeinejs/std'
import fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import { kBodyBuffer } from '../decorators/keys/keys.js'
import {
  Args,
  BodyAsStream,
  Controller,
  Post,
  Router,
  bodyAsBuffer,
  bodyAsStream,
  createWebApplication,
  fastifyAdapterFactory,
  fst,
  type RouteExtension,
} from '../index.js'
import { $p } from '../route_picker.js'
import { RouteBuilder } from '../routing/builder.js'

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

      const app = createWebApplication(fastifyAdapterFactory(fastify())).mount(router)
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

      const app = createWebApplication(fastifyAdapterFactory(fastify())).mount(router)
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

  describe('given several extensions in one call', () => {
    it('should apply them in argument order', () => {
      const seen: string[] = []
      const mark =
        (tag: string): RouteExtension =>
        route => {
          seen.push(tag)
          route.extras(kMark, tag)
        }

      const router = new Router('/order')
      router
        .get('/')
        .with(mark('first'), mark('second'), mark('third'))
        .handler(() => null)

      expect(seen).toEqual(['first', 'second', 'third'])
    })
  })

  describe('given a decorator and its extension', () => {
    it('should write the same spec', () => {
      const viaExtension = new RouteBuilder()
      bodyAsBuffer()(viaExtension)

      const viaDecoratorEquivalent = new RouteBuilder()
      viaDecoratorEquivalent.extras(kBodyBuffer, true)

      expect(viaExtension.toRoute().extras).toEqual(viaDecoratorEquivalent.toRoute().extras)
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
        .with(
          fst({
            onRequest: (_req, _res, done) => {
              order.push('fst')
              done()
            },
          }),
        )
        .handler(() => {
          order.push('handler')
          return { ok: true }
        })

      const app = createWebApplication(fastifyAdapterFactory(fastify())).mount(router)
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
          const { validationError } = ctx.fst.request as { validationError?: unknown }
          return { invalid: validationError !== undefined }
        })

      const app = createWebApplication(fastifyAdapterFactory(fastify())).mount(router)
      await app.ready()

      // attachValidation turns a validation failure into a flag on the request instead of a 400.
      const res = await app.fetch('/fst-opts/validated?n=nope')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ invalid: true })

      await app.close()
    })
  })
})
