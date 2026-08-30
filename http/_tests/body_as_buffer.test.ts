import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Controller, Post, Args, createWebApplication, fastifyAdapterFactory, BodyAsBuffer } from '../index.js'
import { $p } from '../route_picker.js'

describe('BodyAsBuffer', () => {
  it('delivers the body as a Buffer regardless of content-type', async () => {
    @Controller('/raw')
    class RawController {
      @BodyAsBuffer()
      @Post('/upload')
      @Args([$p.body()])
      upload(b: Buffer) {
        return { size: b.byteLength, isBuffer: Buffer.isBuffer(b) }
      }
    }

    void [RawController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const payload = Buffer.from('hello raw world')

    const res = await app.fetch('/raw/upload', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: payload })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ size: payload.byteLength, isBuffer: true })
  })

  it('receives binary data correctly (application/octet-stream)', async () => {
    @Controller('/raw-binary')
    class RawBinaryController {
      @BodyAsBuffer()
      @Post('/data')
      @Args([$p.body()])
      data(b: Buffer) {
        return { bytes: Array.from(b) }
      }
    }

    void [RawBinaryController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const payload = Buffer.from([0x01, 0x02, 0x03, 0xff])

    const res = await app.fetch('/raw-binary/data', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: payload })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ bytes: [1, 2, 3, 255] })
  })

  it('receives JSON payload as raw Buffer without parsing', async () => {
    @Controller('/raw-json')
    class RawJSONController {
      @BodyAsBuffer()
      @Post('/data')
      @Args([$p.body()])
      data(b: Buffer) {
        return { raw: b.toString('utf8') }
      }
    }

    void [RawJSONController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const jsonStr = JSON.stringify({ key: 'value' })

    const res = await app.fetch('/raw-json/data', { method: 'POST', headers: { 'content-type': 'application/json' }, body: jsonStr })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ raw: jsonStr })
  })

  it('does not affect other routes on the same controller', async () => {
    @Controller('/raw-mixed')
    class MixedController {
      @BodyAsBuffer()
      @Post('/raw')
      @Args([$p.body()])
      rawRoute(b: Buffer) {
        return { isBuffer: Buffer.isBuffer(b) }
      }

      @Post('/parsed')
      @Args([$p.body()])
      parsedRoute(b: unknown) {
        return { body: b }
      }
    }

    void [MixedController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    await app.ready()

    const rawRes = await app.fetch('/raw-mixed/raw', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hello' })

    const parsedRes = await app.fetch('/raw-mixed/parsed', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 1 }) })

    expect(rawRes.status).toBe(200)
    expect(await rawRes.json()).toEqual({ isBuffer: true })

    expect(parsedRes.status).toBe(200)
    expect(await parsedRes.json()).toEqual({ body: { x: 1 } })
  })
})
