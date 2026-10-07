import { once } from 'node:events'
import { connect } from 'node:net'

import { describe, it, expect, vi } from 'vitest'

import { Controller, Post, Args, createWebApplication, BodyAsStream, BodyLimit } from '../index.js'
import { $p } from '../routing/picker.js'

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
    await app.bootstrap()

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
    await app.bootstrap()

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
    await app.bootstrap()

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
    await app.bootstrap()

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

  /** Reads the whole stream, as a handler collecting an upload would: unbounded unless the stream itself is. */
  async function sizeOf(stream: ReadableStream<Uint8Array>): Promise<{ size: number }> {
    let size = 0
    for await (const chunk of stream) {
      size += chunk.byteLength
    }
    return { size }
  }

  // Fastify holds only a body it reads itself to a limit: a stream handed on is held to it by the route.
  it("refuses a body whose Content-Length is over the route's limit with 413, before the handler runs", async () => {
    let handled = 0

    @Controller('/stream-limited')
    class LimitedStreamController {
      @BodyAsStream()
      @BodyLimit(1024)
      @Post('/upload')
      @Args([$p.body()])
      upload(stream: ReadableStream<Uint8Array>) {
        handled++
        return sizeOf(stream)
      }
    }

    void [LimitedStreamController]

    const app = createWebApplication()
    await app.bootstrap()

    const upload = (bytes: number) =>
      app.fetch('/stream-limited/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(bytes),
      })

    const over = await upload(4096)
    expect(over.status).toBe(413)
    expect(await over.json()).toMatchObject({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' })

    expect(await (await upload(1024)).json()).toEqual({ size: 1024 })
    expect(handled).toBe(1)
    await app.close()
  })

  it("refuses a body over the server's limit when the route sets none", async () => {
    @Controller('/stream-server-limited')
    class ServerLimitedStreamController {
      @BodyAsStream()
      @Post('/upload')
      @Args([$p.body()])
      upload(stream: ReadableStream<Uint8Array>) {
        return sizeOf(stream)
      }
    }

    void [ServerLimitedStreamController]

    const app = createWebApplication().server(() => ({ factory: { bodyLimit: 2048 } }))
    await app.bootstrap()

    const upload = (bytes: number) =>
      app.fetch('/stream-server-limited/upload', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: Buffer.alloc(bytes),
      })

    expect((await upload(4096)).status).toBe(413)
    expect(await (await upload(2048)).json()).toEqual({ size: 2048 })
    await app.close()
  })

  // A chunked body declares no length, so nothing can be refused up front: the stream fails as it passes the limit.
  it("fails a chunked body as it passes the route's limit, with 413", async () => {
    @Controller('/stream-chunked')
    class ChunkedStreamController {
      @BodyAsStream()
      @BodyLimit(1024)
      @Post('/upload')
      @Args([$p.body()])
      upload(stream: ReadableStream<Uint8Array>) {
        return sizeOf(stream)
      }
    }

    void [ChunkedStreamController]

    const app = createWebApplication().server(() => ({ listener: { host: '127.0.0.1', port: 0 } }))
    await app.run()

    const chunked = (bytes: number) => {
      let sent = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          const size = Math.min(256, bytes - sent)
          sent += size
          if (size === 0) {
            controller.close()
          } else {
            controller.enqueue(new Uint8Array(size))
          }
        },
      })

      return fetch(`${app.address!.origin}/stream-chunked/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body,
        duplex: 'half',
      } as RequestInit)
    }

    try {
      const over = await chunked(4096)
      expect(over.status).toBe(413)
      expect(await over.json()).toMatchObject({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' })

      expect(await (await chunked(1024)).json()).toEqual({ size: 1024 })
    } finally {
      await app.close()
    }
  })

  // A client that leaves mid-upload sends no more bytes: the handler's read must fail, not wait for them for ever.
  it('fails the read of a body whose client leaves mid-upload, and goes on serving', async () => {
    const reads: string[] = []

    @Controller('/stream-abandoned')
    class AbandonedStreamController {
      @BodyAsStream()
      @Post('/upload')
      @Args([$p.body()])
      async upload(stream: ReadableStream<Uint8Array>) {
        reads.push('reading')
        try {
          const { size } = await sizeOf(stream)
          reads.push(`read ${size}`)
        } catch {
          reads.push('failed')
        }
        return { reads: reads.length }
      }
    }

    void [AbandonedStreamController]

    const app = createWebApplication().server(() => ({ listener: { host: '127.0.0.1', port: 0 } }))
    await app.run()

    try {
      const socket = connect(app.address!.port, '127.0.0.1')
      await once(socket, 'connect')
      socket.write(
        'POST /stream-abandoned/upload HTTP/1.1\r\nHost: localhost\r\n' +
          'Content-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n' +
          `100\r\n${'x'.repeat(256)}\r\n`,
      )
      await vi.waitFor(() => expect(reads).toEqual(['reading']))
      socket.destroy()

      await vi.waitFor(() => expect(reads).toEqual(['reading', 'failed']))

      const next = await fetch(`${app.address!.origin}/stream-abandoned/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: 'next',
      })
      expect(next.status).toBe(200)
      expect(reads.slice(2)).toEqual(['reading', 'read 4'])
    } finally {
      await app.close()
    }
  })
})
