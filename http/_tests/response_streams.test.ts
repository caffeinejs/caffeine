import { Readable } from 'node:stream'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Router } from '../index.js'
import { createWebApplication } from '../platform/fastify/index.js'
import { expectPatternedBody, streamOf } from './bodies.js'
import { firstMismatch, patterned } from './patterned.js'

const OCTET = 'application/octet-stream'
const BYTES = patterned(0, 1000)

describe('a stream a handler returns goes out labelled as bytes, unless something declared its type', () => {
  // The HEAD route reports whether the stream behind it was released, rather than read to the end.
  const cancelled: unknown[] = []

  const routes = new Router('/streams')
  routes.get('/web').handler(() => streamOf(BYTES))
  routes
    .get('/node')
    .handler(() => Readable.from([Buffer.from(BYTES.subarray(0, 500)), Buffer.from(BYTES.subarray(500))]))
  routes.get('/generator').handler(() =>
    Readable.from(
      (async function* () {
        yield Buffer.from(BYTES.subarray(0, 500))
        yield Buffer.from(BYTES.subarray(500))
      })(),
    ),
  )
  routes.get('/strings').handler(() => Readable.from(['region,total\n', 'north,12\n']))
  routes.get('/response').handler(() => new Response(streamOf(BYTES)))
  routes.get('/empty').handler(
    () =>
      new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
  )
  routes
    .get('/produces-web')
    .produces('text/csv')
    .handler(() => streamOf(BYTES))
  routes
    .get('/produces-node')
    .produces('text/csv')
    .handler(() => Readable.from([Buffer.from(BYTES)]))
  routes
    .get('/produces-response')
    .produces('text/csv')
    .handler(() => new Response(streamOf(BYTES)))
  routes.get('/handler-type').handler(ctx => {
    ctx.header('content-type', 'text/event-stream')
    return streamOf(BYTES)
  })
  routes
    .get('/response-typed')
    .handler(() => new Response(streamOf(BYTES), { headers: { 'content-type': 'text/csv' } }))
  routes.get('/response-blob').handler(() => new Response(new Blob([BYTES], { type: 'application/pdf' })))
  routes.get('/cancellable').handler(() => {
    let pulls = 0

    return new ReadableStream({
      pull(controller) {
        // Finite, so a HEAD that reads it through ends — and fails the test on `cancelled` — instead of hanging.
        if (++pulls > 100) {
          controller.close()
          return
        }

        controller.enqueue(BYTES)
      },
      cancel(reason) {
        cancelled.push(reason)
      },
    })
  })

  const app = createWebApplication().mount(routes)

  beforeAll(async () => {
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  it.each([
    ['a web ReadableStream', '/streams/web'],
    ['a Node Readable', '/streams/node'],
    ['a Readable an async generator feeds', '/streams/generator'],
    ['a Response built around a stream', '/streams/response'],
  ])('sends %s as application/octet-stream, as Fastify sends bytes', async (_kind, path) => {
    const res = await app.fetch(path)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(OCTET)
    await expectPatternedBody(res, 0, BYTES.length)
  })

  it('sends a Readable of strings as application/octet-stream too: nothing declared it text', async () => {
    const res = await app.fetch('/streams/strings')

    expect(res.headers.get('content-type')).toBe(OCTET)
    expect(await res.text()).toBe('region,total\nnorth,12\n')
  })

  it('sends a stream that yields nothing as an empty body', async () => {
    const res = await app.fetch('/streams/empty')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(OCTET)
    expect(await res.text()).toBe('')
  })

  it.each([
    ['a web ReadableStream', '/streams/produces-web'],
    ['a Node Readable', '/streams/produces-node'],
    ['a Response built around a stream', '/streams/produces-response'],
  ])("sends %s under the route's declared type", async (_kind, path) => {
    const res = await app.fetch(path)

    expect(res.headers.get('content-type')).toMatch(/^text\/csv/)
    await expectPatternedBody(res, 0, BYTES.length)
  })

  it('sends a stream under the type its handler set on the reply', async () => {
    const res = await app.fetch('/streams/handler-type')

    expect(res.headers.get('content-type')).toBe('text/event-stream')
    await expectPatternedBody(res, 0, BYTES.length)
  })

  it('keeps the type a Response was built with', async () => {
    const res = await app.fetch('/streams/response-typed')

    expect(res.headers.get('content-type')).toBe('text/csv')
    await expectPatternedBody(res, 0, BYTES.length)
  })

  it('keeps the type a Response takes from the Blob it was built around', async () => {
    const res = await app.fetch('/streams/response-blob')

    expect(res.headers.get('content-type')).toBe('application/pdf')
    await expectPatternedBody(res, 0, BYTES.length)
  })

  it('releases the stream behind a HEAD request instead of reading it: a cursor or an upstream call can close', async () => {
    cancelled.length = 0

    const res = await app.fetch('/streams/cancellable', { method: 'HEAD' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(OCTET)
    expect(await res.text()).toBe('')
    expect(cancelled).toHaveLength(1)
  })
})

describe('over a socket, a returned stream', () => {
  // Released by the test once it has seen the first chunk arrive: the second exists only after that.
  let release: () => void = () => {}

  const routes = new Router('/live')
  routes.get('/held').handler(() => {
    const held = new Promise<void>(resolve => (release = resolve))

    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BYTES.slice(0, 500))
      },
      async pull(controller) {
        await held
        controller.enqueue(BYTES.slice(500))
        controller.close()
      },
    })
  })
  routes.get('/whole').handler(() => streamOf(BYTES))
  routes.get('/broken').handler(() => {
    let sent = false

    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new Error('The storage backend went away mid-read'))
          return
        }

        sent = true
        controller.enqueue(patterned(0, 1 << 20))
      },
    })
  })

  const app = createWebApplication()
    .server(() => ({ listener: { host: '127.0.0.1', port: 0 } }))
    .mount(routes)

  beforeAll(async () => {
    await app.run()
  })

  afterAll(async () => {
    await app.close()
  })

  it('reaches the client chunk by chunk, before the stream has finished', async () => {
    const res = await fetch(`${app.address!.origin}/live/held`)
    const reader = res.body!.getReader()

    // The rest of the body does not exist yet: this read can only complete if the first chunk was sent on its own.
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(firstMismatch(first.value!, 0)).toBe(-1)

    release()

    const rest: Uint8Array[] = [first.value!]
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest.push(chunk.value)
    }
    const body = Buffer.concat(rest)
    expect(body.length).toBe(BYTES.length)
    expect(firstMismatch(body, 0)).toBe(-1)
  })

  it('is sent chunked under application/octet-stream, since its length is not known', async () => {
    const res = await fetch(`${app.address!.origin}/live/whole`)

    expect(res.headers.get('content-type')).toBe(OCTET)
    expect(res.headers.get('content-length')).toBeNull()
    expect(res.headers.get('transfer-encoding')).toBe('chunked')
    await expectPatternedBody(res, 0, BYTES.length)
  })

  it('fails the download when its source fails mid-way, rather than ending it as if it were complete', async () => {
    const res = await fetch(`${app.address!.origin}/live/broken`)

    expect(res.status).toBe(200)
    await expect(res.arrayBuffer()).rejects.toThrow()

    // And the server goes on serving.
    const next = await fetch(`${app.address!.origin}/live/whole`)
    expect(next.status).toBe(200)
    await expectPatternedBody(next, 0, BYTES.length)
  })
})
