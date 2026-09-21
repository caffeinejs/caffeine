import fastifyCompress from '@fastify/compress'
import { type FastifyPluginAsync } from 'fastify'
import fp from 'fastify-plugin'
import { describe, it, expect } from 'vitest'

import {
  Compress,
  compress,
  Controller,
  Get,
  Router,
  RouteBuilder,
  RouteGroupBuilder,
  createWebApplication,
  type CompressOptions,
} from '../index.js'

function compressApp(options: CompressOptions = {}) {
  const plugin: FastifyPluginAsync = async instance => {
    await instance.register(fastifyCompress, options)
  }

  return createWebApplication({}).with(() => fp(plugin, { name: 'compress' }))
}

describe('Compress', () => {
  describe('global compress plugin registration', () => {
    it('compresses responses when compression is activated', async () => {
      @Controller('/compress-global')
      class GlobalCompressController {
        @Get('/data')
        get() {
          return { message: 'hello world'.repeat(100) }
        }
      }

      void [GlobalCompressController]

      const app = compressApp()
      await app.ready()

      const res = await app.fetch('/compress-global/data', { headers: { 'accept-encoding': 'br, gzip, deflate' } })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toMatch(/br|gzip|deflate/)
    })

    it('does not compress responses when the compress plugin is not registered', async () => {
      @Controller('/no-compress')
      class NoCompressController {
        @Get('/data')
        get() {
          return { message: 'hello world'.repeat(100) }
        }
      }

      void [NoCompressController]

      const app = createWebApplication({})
      await app.ready()

      const res = await app.fetch('/no-compress/data', { headers: { 'accept-encoding': 'br, gzip, deflate' } })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBeNull()
    })
  })

  describe('@Compress decorator', () => {
    it('@Compress(false) disables compression for the route while global compression applies elsewhere', async () => {
      @Controller('/compress-mixed')
      class MixedCompressController {
        @Compress(false)
        @Get('/no-compress')
        noCompress() {
          return { message: 'hello world'.repeat(100) }
        }

        @Get('/with-compress')
        withCompress() {
          return { message: 'hello world'.repeat(100) }
        }
      }

      void [MixedCompressController]

      const app = compressApp()
      await app.ready()

      const resOff = await app.fetch('/compress-mixed/no-compress', {
        headers: { 'accept-encoding': 'br, gzip, deflate' },
      })

      const resOn = await app.fetch('/compress-mixed/with-compress', {
        headers: { 'accept-encoding': 'br, gzip, deflate' },
      })

      expect(resOff.status).toBe(200)
      expect(resOff.headers.get('content-encoding')).toBeNull()

      expect(resOn.status).toBe(200)
      expect(resOn.headers.get('content-encoding')).toMatch(/br|gzip|deflate/)
    })

    it('@Compress({ threshold: 1 }) forces compression on small payloads that the global threshold skips', async () => {
      @Controller('/compress-threshold')
      class ThresholdController {
        @Compress({ threshold: 1 })
        @Get('/low-threshold')
        lowThreshold() {
          return { msg: 'small' }
        }

        @Get('/default-threshold')
        defaultThreshold() {
          return { msg: 'small' }
        }
      }

      void [ThresholdController]

      // Default threshold is 1024 bytes — small payload won't be compressed globally
      const app = compressApp({ threshold: 1024 })
      await app.ready()

      const resLow = await app.fetch('/compress-threshold/low-threshold', { headers: { 'accept-encoding': 'gzip' } })

      const resDefault = await app.fetch('/compress-threshold/default-threshold', {
        headers: { 'accept-encoding': 'gzip' },
      })

      expect(resLow.status).toBe(200)
      expect(resLow.headers.get('content-encoding')).toBe('gzip')

      expect(resDefault.status).toBe(200)
      expect(resDefault.headers.get('content-encoding')).toBeNull()
    })
  })

  describe('compress() extension', () => {
    it('writes the same spec as an equivalent options.compress assignment', () => {
      const viaExtension = new RouteBuilder()
      compress(false)(viaExtension)

      const viaOptions = new RouteBuilder()
      viaOptions.options('compress', false)

      expect(viaExtension.toRoute().options).toEqual(viaOptions.toRoute().options)
    })

    it('applies at group level too', () => {
      const group = new RouteGroupBuilder()
      compress({ threshold: 1024 })(group)

      expect(group.toRouteGroup().options?.get('compress')).toEqual({ threshold: 1024 })
    })

    it('disables compression for every route of the group while global compression applies elsewhere', async () => {
      const router = new Router('/ext-compress').with(compress(false))
      router.get('/a').handler(() => ({ message: 'hello world'.repeat(100) }))
      router.get('/b').handler(() => ({ message: 'hello world'.repeat(100) }))

      const compressed = new Router('/ext-compressed')
      compressed.get('/a').handler(() => ({ message: 'hello world'.repeat(100) }))

      const app = compressApp().mount(router, compressed)
      await app.ready()

      const headers = { 'accept-encoding': 'br, gzip, deflate' }

      expect((await app.fetch('/ext-compress/a', { headers })).headers.get('content-encoding')).toBeNull()
      expect((await app.fetch('/ext-compress/b', { headers })).headers.get('content-encoding')).toBeNull()
      expect((await app.fetch('/ext-compressed/a', { headers })).headers.get('content-encoding')).toMatch(
        /br|gzip|deflate/,
      )
    })
  })
})
