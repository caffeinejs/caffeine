import { $t } from '@caffeinejs/application/schema'
import { describe, expect, it } from 'vitest'

import { RouteBuilder } from '../core/routing/builder.js'
import { $p } from '../core/routing/picker.js'
import {
  Args,
  BodyAsStream,
  Controller,
  Post,
  Router,
  bodyAsBuffer,
  bodyAsStream,
  type RouteExtension,
} from '../index.js'
import { createWebApplication, fst } from '../platform/fastify/index.js'

// A third party annotating a route it does not own: the namespace is declared here, exactly as
// `@caffeinejs/openapi` declares its own.
declare module '../core/routing/spec.js' {
  interface RouteDetail {
    testMark?: string
  }
}

describe('route extensions', () => {
  describe('given a body-reading extension', () => {
    it('should deliver the body the way its decorator does', async () => {
      const router = new Router('/ext-stream')
      router
        .post('/upload')
        .extend(bodyAsStream())
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

      const app = createWebApplication().mount(router)
      await app.bootstrap()

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
        .extend(bodyAsBuffer())
        .handler(ctx => {
          const body = ctx.req.body() as Buffer
          return { isBuffer: Buffer.isBuffer(body), text: body.toString() }
        })

      const app = createWebApplication().mount(router)
      await app.bootstrap()

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
          route.detail('testMark', tag)
        }

      const router = new Router('/order')
      router
        .get('/')
        .extend(mark('first'), mark('second'), mark('third'))
        .handler(() => null)

      expect(seen).toEqual(['first', 'second', 'third'])
    })

    it('should apply every group extension, the later winning where two write the same header', async () => {
      const router = new Router('/group-ext').extend(
        group => {
          group.header('x-first', 'yes')
          group.header('x-shared', 'first')
        },
        group => {
          group.header('x-second', 'yes')
          group.header('x-shared', 'second')
        },
      )
      router.get('/').handler(() => ({ ok: true }))

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      const res = await app.fetch('/group-ext')
      expect(res.headers.get('x-first')).toBe('yes')
      expect(res.headers.get('x-second')).toBe('yes')
      expect(res.headers.get('x-shared')).toBe('second')

      await app.close()
    })
  })

  // Detail is what a reader of the routes, such as the OpenAPI generator, finds on each level: never merged down
  // into a group's routes, but inherited by a group nested in it.
  describe('given detail on a group and on a route', () => {
    it('should keep each on its own level, and pass the group detail to a nested group', async () => {
      const router = new Router('/detailed').detail('http', { internal: true })
      router
        .get('/')
        .detail('testMark', 'route')
        .handler(() => null)
      router.group('/nested', nested => {
        nested.get('/').handler(() => null)
      })

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      const outer = app.routeGroups.find(group => group.path === '/detailed')!
      const nested = app.routeGroups.find(group => group.path === '/detailed/nested')!
      expect(outer.detail).toEqual({ http: { internal: true } })
      expect(outer.routes[0].detail).toEqual({ testMark: 'route' })
      expect(nested.detail).toEqual({ http: { internal: true } })
      expect(nested.routes[0].detail).toBeUndefined()

      await app.close()
    })
  })

  describe('given a decorator and its extension', () => {
    it('should write the same spec', () => {
      const viaExtension = new RouteBuilder()
      bodyAsBuffer()(viaExtension)

      const viaDecoratorEquivalent = new RouteBuilder()
      viaDecoratorEquivalent.bodyAs('buffer')

      expect(viaExtension.toRoute().bodyAs).toEqual(viaDecoratorEquivalent.toRoute().bodyAs)
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
        .extend(
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

      const app = createWebApplication().mount(router)
      await app.bootstrap()

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
        .extend(fst({ attachValidation: true }))
        .schema({ querystring: $t.Object({ n: $t.Integer() }) })
        .handler(ctx => {
          const { validationError } = ctx.platform.request as { validationError?: unknown }
          return { invalid: validationError !== undefined }
        })

      const app = createWebApplication().mount(router)
      await app.bootstrap()

      // attachValidation turns a validation failure into a flag on the request instead of a 400.
      const res = await app.fetch('/fst-opts/validated?n=nope')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ invalid: true })

      await app.close()
    })
  })
})
