import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import { Controller, Post, Params, body, newHTTP } from '@caffeinejs/http'
import { fastifyAdapterFactory, BodyAsStream } from '../index.js'

describe('BodyAsStream', () => {
  it('delivers the body as a ReadableStream', async () => {
    @Controller('/stream')
    class StreamController {
      @BodyAsStream()
      @Post('/upload')
      @Params([body()])
      async upload(stream: ReadableStream) {
        const isStream = stream instanceof ReadableStream
        const chunks: Uint8Array[] = []
        for await (const chunk of stream) {
          chunks.push(chunk)
        }
        const total = chunks.reduce((n, c) => n + c.byteLength, 0)
        return { isStream, size: total }
      }
    }

    void [StreamController]

    const app = newHTTP(fastifyAdapterFactory(fastify()))
    await app.ready()

    const payload = Buffer.from('hello stream world')

    const res = await app.instance.inject({
      method: 'POST',
      url: '/stream/upload',
      payload,
      headers: { 'content-type': 'text/plain' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ isStream: true, size: payload.byteLength })
  })

  it('yields correct bytes for binary data (application/octet-stream)', async () => {
    @Controller('/stream-binary')
    class StreamBinaryController {
      @BodyAsStream()
      @Post('/data')
      @Params([body()])
      async data(stram: ReadableStream) {
        const chunks: Uint8Array[] = []
        for await (const chunk of stram) {
          chunks.push(chunk)
        }
        const buf = Buffer.concat(chunks)
        return { bytes: Array.from(buf) }
      }
    }

    void [StreamBinaryController]

    const app = newHTTP(fastifyAdapterFactory(fastify()))
    await app.ready()

    const payload = Buffer.from([0x01, 0x02, 0x03, 0xff])

    const res = await app.instance.inject({
      method: 'POST',
      url: '/stream-binary/data',
      payload,
      headers: { 'content-type': 'application/octet-stream' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ bytes: [1, 2, 3, 255] })
  })

  it('receives JSON payload as a stream without parsing', async () => {
    @Controller('/stream-json')
    class StreamJsonController {
      @BodyAsStream()
      @Post('/data')
      @Params([body()])
      async data(stream: ReadableStream) {
        const chunks: Uint8Array[] = []
        for await (const chunk of stream) {
          chunks.push(chunk)
        }
        return { raw: Buffer.concat(chunks).toString('utf8') }
      }
    }

    void [StreamJsonController]

    const app = newHTTP(fastifyAdapterFactory(fastify()))
    await app.ready()

    const jsonStr = JSON.stringify({ key: 'value' })

    const res = await app.instance.inject({
      method: 'POST',
      url: '/stream-json/data',
      payload: jsonStr,
      headers: { 'content-type': 'application/json' },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ raw: jsonStr })
  })

  it('does not affect other routes on the same controller', async () => {
    @Controller('/stream-mixed')
    class MixedController {
      @BodyAsStream()
      @Post('/raw')
      @Params([body()])
      async rawRoute(stream: ReadableStream) {
        return { isStream: stream instanceof ReadableStream }
      }

      @Post('/parsed')
      @Params([body()])
      parsedRoute(b: unknown) {
        return { body: b }
      }
    }

    void [MixedController]

    const app = newHTTP(fastifyAdapterFactory(fastify()))
    await app.ready()

    const streamRes = await app.instance.inject({
      method: 'POST',
      url: '/stream-mixed/raw',
      payload: 'hello',
      headers: { 'content-type': 'text/plain' },
    })

    const parsedRes = await app.instance.inject({
      method: 'POST',
      url: '/stream-mixed/parsed',
      payload: JSON.stringify({ x: 1 }),
      headers: { 'content-type': 'application/json' },
    })

    expect(streamRes.statusCode).toBe(200)
    expect(streamRes.json()).toEqual({ isStream: true })

    expect(parsedRes.statusCode).toBe(200)
    expect(parsedRes.json()).toEqual({ body: { x: 1 } })
  })
})
