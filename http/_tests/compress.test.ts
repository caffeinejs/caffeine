import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import compress from '@fastify/compress'
import { Controller, Get, createWebApplication, fastifyAdapterFactory, Compress } from '../index.js'

describe('Compress', () => {
  it('compresses responses when @fastify/compress is registered globally', async () => {
    @Controller('/compress-global')
    class GlobalCompressController {
      @Get('/data')
      get() {
        return { message: 'hello world'.repeat(100) }
      }
    }

    void [GlobalCompressController]

    const server = fastify()
    await server.register(compress, { global: true })

    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    const res = await app.fetch('/compress-global/data', { headers: { 'accept-encoding': 'br, gzip, deflate' } })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-encoding')).toMatch(/br|gzip|deflate/)
  })

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

    const server = fastify()
    await server.register(compress, { global: true })

    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    const resOff = await app.fetch('/compress-mixed/no-compress', { headers: { 'accept-encoding': 'br, gzip, deflate' } })

    const resOn = await app.fetch('/compress-mixed/with-compress', { headers: { 'accept-encoding': 'br, gzip, deflate' } })

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

    const server = fastify()
    // Default threshold is 1024 bytes — small payload won't be compressed globally
    await server.register(compress, { global: true, threshold: 1024 })

    const app = createWebApplication(fastifyAdapterFactory(server)).build()
    await app.ready()

    const resLow = await app.fetch('/compress-threshold/low-threshold', { headers: { 'accept-encoding': 'gzip' } })

    const resDefault = await app.fetch('/compress-threshold/default-threshold', { headers: { 'accept-encoding': 'gzip' } })

    expect(resLow.status).toBe(200)
    expect(resLow.headers.get('content-encoding')).toBe('gzip')

    expect(resDefault.status).toBe(200)
    expect(resDefault.headers.get('content-encoding')).toBeNull()
  })
})
