import { describe, it, expect } from 'vitest'

import { Controller, Post, Args, createWebApplication, BodyAsBuffer, BodyLimit } from '../index.js'
import { $p } from '../routing/picker.js'

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

    const app = createWebApplication()
    await app.bootstrap()

    const payload = Buffer.from('hello raw world')

    const res = await app.fetch('/raw/upload', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: payload,
    })

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

    const app = createWebApplication()
    await app.bootstrap()

    const payload = Buffer.from([0x01, 0x02, 0x03, 0xff])

    const res = await app.fetch('/raw-binary/data', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: payload,
    })

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

    const app = createWebApplication()
    await app.bootstrap()

    const jsonStr = JSON.stringify({ key: 'value' })

    const res = await app.fetch('/raw-json/data', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: jsonStr,
    })

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

    const app = createWebApplication()
    await app.bootstrap()

    const rawRes = await app.fetch('/raw-mixed/raw', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    })

    const parsedRes = await app.fetch('/raw-mixed/parsed', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: 1 }),
    })

    expect(rawRes.status).toBe(200)
    expect(await rawRes.json()).toEqual({ isBuffer: true })

    expect(parsedRes.status).toBe(200)
    expect(await parsedRes.json()).toEqual({ body: { x: 1 } })
  })

  // A raw body is read whole into memory: the limit is all that keeps one request from taking it all.
  it("refuses a body over the route's limit with 413, before the handler runs", async () => {
    let handled = 0

    @Controller('/raw-limited')
    class LimitedController {
      @BodyAsBuffer()
      @BodyLimit(1024)
      @Post('/upload')
      @Args([$p.body()])
      upload(b: Buffer) {
        handled++
        return { size: b.byteLength }
      }
    }

    void [LimitedController]

    const app = createWebApplication()
    await app.bootstrap()

    const upload = (bytes: number) =>
      app.fetch('/raw-limited/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(bytes),
      })

    const over = await upload(4096)
    expect(over.status).toBe(413)
    expect(await over.json()).toMatchObject({ code: 'FST_ERR_CTP_BODY_TOO_LARGE' })

    const within = await upload(1024)
    expect(within.status).toBe(200)
    expect(await within.json()).toEqual({ size: 1024 })
    expect(handled).toBe(1)
    await app.close()
  })

  it("refuses a body over the server's limit when the route sets none", async () => {
    @Controller('/raw-server-limited')
    class ServerLimitedController {
      @BodyAsBuffer()
      @Post('/upload')
      @Args([$p.body()])
      upload(b: Buffer) {
        return { size: b.byteLength }
      }
    }

    void [ServerLimitedController]

    const app = createWebApplication().server(() => ({ factory: { bodyLimit: 2048 } }))
    await app.bootstrap()

    const upload = (bytes: number) =>
      app.fetch('/raw-server-limited/upload', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: Buffer.alloc(bytes),
      })

    expect((await upload(4096)).status).toBe(413)
    expect(await (await upload(2048)).json()).toEqual({ size: 2048 })
    await app.close()
  })
})
