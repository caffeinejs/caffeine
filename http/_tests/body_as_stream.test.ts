import { describe, it, expect } from 'vitest'

import { Controller, Post, Args, createWebApplication, BodyAsStream } from '../index.js'
import { $p } from '../route_picker.js'

describe('BodyAsStream', () => {
  it('delivers the body as a ReadableStream', async () => {
    @Controller('/stream')
    class StreamController {
      @BodyAsStream()
      @Post('/upload')
      @Args([$p.body()])
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

    const app = createWebApplication()
    await app.ready()

    const payload = Buffer.from('hello stream world')

    const res = await app.fetch('/stream/upload', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: payload,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ isStream: true, size: payload.byteLength })
  })

  it('yields correct bytes for binary data (application/octet-stream)', async () => {
    @Controller('/stream-binary')
    class StreamBinaryController {
      @BodyAsStream()
      @Post('/data')
      @Args([$p.body()])
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

    const app = createWebApplication()
    await app.ready()

    const payload = Buffer.from([0x01, 0x02, 0x03, 0xff])

    const res = await app.fetch('/stream-binary/data', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ bytes: [1, 2, 3, 255] })
  })

  it('receives JSON payload as a stream without parsing', async () => {
    @Controller('/stream-json')
    class StreamJSONController {
      @BodyAsStream()
      @Post('/data')
      @Args([$p.body()])
      async data(stream: ReadableStream) {
        const chunks: Uint8Array[] = []
        for await (const chunk of stream) {
          chunks.push(chunk)
        }
        return { raw: Buffer.concat(chunks).toString('utf8') }
      }
    }

    void [StreamJSONController]

    const app = createWebApplication()
    await app.ready()

    const jsonStr = JSON.stringify({ key: 'value' })

    const res = await app.fetch('/stream-json/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonStr,
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ raw: jsonStr })
  })

  it('does not affect other routes on the same controller', async () => {
    @Controller('/stream-mixed')
    class MixedController {
      @BodyAsStream()
      @Post('/raw')
      @Args([$p.body()])
      async rawRoute(stream: ReadableStream) {
        return { isStream: stream instanceof ReadableStream }
      }

      @Post('/parsed')
      @Args([$p.body()])
      parsedRoute(b: unknown) {
        return { body: b }
      }
    }

    void [MixedController]

    const app = createWebApplication()
    await app.ready()

    const streamRes = await app.fetch('/stream-mixed/raw', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    })

    const parsedRes = await app.fetch('/stream-mixed/parsed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    })

    expect(streamRes.status).toBe(200)
    expect(await streamRes.json()).toEqual({ isStream: true })

    expect(parsedRes.status).toBe(200)
    expect(await parsedRes.json()).toEqual({ body: { x: 1 } })
  })
})
