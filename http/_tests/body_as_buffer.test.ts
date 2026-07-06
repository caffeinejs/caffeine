import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Controller, Post, Params, createWebApplication } from '@caffeinejs/application'
import { fastifyAdapterFactory, BodyAsBuffer } from '../index.js'
import { body } from '../route_picker.js'

describe('BodyAsBuffer', () => {
  it('delivers the body as a Buffer regardless of content-type', async () => {
    @Controller('/raw')
    class RawController {
      @BodyAsBuffer()
      @Post('/upload')
      @Params([body()])
      upload(b: Buffer) {
        return { size: b.byteLength, isBuffer: Buffer.isBuffer(b) }
      }
    }

    void [RawController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const payload = Buffer.from('hello raw world')

    const res = await app.instance.inject({
      method: 'POST',
      url: '/raw/upload',
      payload,
      headers: { 'content-type': 'text/plain' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ size: payload.byteLength, isBuffer: true })
  })

  it('receives binary data correctly (application/octet-stream)', async () => {
    @Controller('/raw-binary')
    class RawBinaryController {
      @BodyAsBuffer()
      @Post('/data')
      @Params([body()])
      data(b: Buffer) {
        return { bytes: Array.from(b) }
      }
    }

    void [RawBinaryController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const payload = Buffer.from([0x01, 0x02, 0x03, 0xff])

    const res = await app.instance.inject({
      method: 'POST',
      url: '/raw-binary/data',
      payload,
      headers: { 'content-type': 'application/octet-stream' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ bytes: [1, 2, 3, 255] })
  })

  it('receives JSON payload as raw Buffer without parsing', async () => {
    @Controller('/raw-json')
    class RawJsonController {
      @BodyAsBuffer()
      @Post('/data')
      @Params([body()])
      data(b: Buffer) {
        return { raw: b.toString('utf8') }
      }
    }

    void [RawJsonController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const jsonStr = JSON.stringify({ key: 'value' })

    const res = await app.instance.inject({
      method: 'POST',
      url: '/raw-json/data',
      payload: jsonStr,
      headers: { 'content-type': 'application/json' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ raw: jsonStr })
  })

  it('does not affect other routes on the same controller', async () => {
    @Controller('/raw-mixed')
    class MixedController {
      @BodyAsBuffer()
      @Post('/raw')
      @Params([body()])
      rawRoute(b: Buffer) {
        return { isBuffer: Buffer.isBuffer(b) }
      }

      @Post('/parsed')
      @Params([body()])
      parsedRoute(b: unknown) {
        return { body: b }
      }
    }

    void [MixedController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const rawRes = await app.instance.inject({
      method: 'POST',
      url: '/raw-mixed/raw',
      payload: 'hello',
      headers: { 'content-type': 'text/plain' },
    })

    const parsedRes = await app.instance.inject({
      method: 'POST',
      url: '/raw-mixed/parsed',
      payload: JSON.stringify({ x: 1 }),
      headers: { 'content-type': 'application/json' },
    })

    expect(rawRes.statusCode).toBe(200)
    expect(rawRes.json()).toEqual({ isBuffer: true })

    expect(parsedRes.statusCode).toBe(200)
    expect(parsedRes.json()).toEqual({ body: { x: 1 } })
  })
})
