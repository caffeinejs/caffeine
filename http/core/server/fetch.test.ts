import { Byte } from '@caffeinejs/std/bytes'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication, type WebApplication } from '../../application.js'
import { Router } from '../routing/programmatic/programmatic.js'
import type { FetchAdapterTypes } from './adapter.js'
import { fetchPlatform } from './fetch.js'

// Any router and any fetch application, as `mount` takes them: the route types each carries are not under test here.
type AnyRouter = Router<any, any, any, any, any, any>
type FetchApp = WebApplication<FetchAdapterTypes, any, any, any>

let app: FetchApp | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

async function serve(router: AnyRouter): Promise<FetchApp> {
  app = createWebApplication().mount(router)
  await app.bootstrap()
  return app
}

/** A stream of two chunks, the second held until `release` is called. */
function latched(): { stream: ReadableStream<Uint8Array>; release: () => void } {
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const encoder = new TextEncoder()

  return {
    release,
    stream: new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('a'))
        await held
        controller.enqueue(encoder.encode('b'))
        controller.close()
      },
    }),
  }
}

describe('fetchPlatform', () => {
  it("hands the runtime's extra arguments to ctx.platform.runtime", async () => {
    const served = await serve(new Router('/p').get('/').handler(ctx => ctx.platform as unknown as object))

    const res = await served.fetch(new Request('http://x/p'), 'env', 'exec')

    expect(await res.json()).toEqual({ name: 'fetch', runtime: ['env', 'exec'] })
  })

  it('reads the protocol off the request URL', async () => {
    const served = await serve(new Router('/p').get('/').handler(ctx => ctx.req.protocol))

    expect(await (await served.fetch(new Request('https://x/p'))).text()).toBe('https')
    expect(await (await served.fetch(new Request('http://x/p'))).text()).toBe('http')
  })

  // A request built in-process names its host in its URL alone, as `ctx.req.host` already reads it.
  it('reads the host off the URL when the request sends no Host header', () => {
    expect(fetchPlatform.header(new Request('http://api.example:8080/x'), 'host')).toBe('api.example:8080')
    expect(fetchPlatform.headers(new Request('http://api.example/x')).host).toBe('api.example')
  })

  it('reads a Host header the request sends over its URL', () => {
    const request = new Request('http://a.example/x', { headers: { host: 'b.example' } })

    expect(fetchPlatform.header(request, 'Host')).toBe('b.example')
    expect(fetchPlatform.headers(request).host).toBe('b.example')
  })

  it('gives ctx.req.raw the very Request handed to fetch', async () => {
    let raw: unknown
    const served = await serve(
      new Router('/p').get('/').handler(ctx => {
        raw = ctx.req.raw
        return 'ok'
      }),
    )
    const request = new Request('http://x/p')

    await (await served.fetch(request)).text()

    expect(raw).toBe(request)
  })

  // Disposing the container under a body still being read would end what the body is made from.
  it('keeps close() waiting until a streamed body has been read', async () => {
    const body = latched()
    const served = await serve(new Router('/s').get('/').handler(() => body.stream))
    const res = await served.fetch(new Request('http://x/s'))
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let closed = false

    const first = await reader.read()
    const closing = served.close().then(() => {
      closed = true
    })
    await new Promise(resolve => setImmediate(resolve))

    expect(decoder.decode(first.value)).toBe('a')
    expect(closed).toBe(false)

    body.release()
    let rest = ''
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += decoder.decode(chunk.value)
    }
    await closing

    expect(rest).toBe('b')
    expect(closed).toBe(true)
    app = undefined
  })

  it('lets close() finish when the client cancels a streamed body', async () => {
    const body = latched()
    const served = await serve(new Router('/s').get('/').handler(() => body.stream))
    const res = await served.fetch(new Request('http://x/s'))

    let closed = false
    await res.body!.cancel()
    const closing = served.close().then(() => {
      closed = true
    })
    await new Promise(resolve => setImmediate(resolve))

    // Before the source is released: the cancel alone ends the body, so close() needs nothing more.
    expect(closed).toBe(true)
    body.release()
    await closing
    app = undefined
  })
})

describe('the body on fetchPlatform', () => {
  const post = (body: RequestInit['body'], headers: Record<string, string> = {}) =>
    new Request('http://x/', { method: 'POST', body, headers })

  it('says a request declares a body only when it carries one of some length', () => {
    expect(fetchPlatform.hasBody(new Request('http://x/'))).toBe(false)
    expect(fetchPlatform.hasBody(post(null))).toBe(false)
    expect(fetchPlatform.hasBody(post('x', { 'content-length': '0' }))).toBe(false)
    expect(fetchPlatform.hasBody(post('x'))).toBe(true)
  })

  it('says a body is consumed once read, or once a reader holds it', async () => {
    const read = post('x')
    await read.text()
    const held = post('x')
    held.body?.getReader()

    expect(fetchPlatform.bodyConsumed(post('x'))).toBe(false)
    expect(fetchPlatform.bodyConsumed(read)).toBe(true)
    expect(fetchPlatform.bodyConsumed(held)).toBe(true)
  })

  it('reads a body whole', async () => {
    expect(new TextDecoder().decode(await fetchPlatform.readBody(post('ping'), 10 * Byte))).toBe('ping')
  })

  it('refuses a body bringing more than the limit', async () => {
    await expect(fetchPlatform.readBody(post('x'.repeat(11)), 10 * Byte)).rejects.toMatchObject({ statusCode: 413 })
  })

  it("hands the runtime's own Request as ctx.req.raw, whatever the limit", () => {
    const request = post('x')

    expect(fetchPlatform.request(request, 10 * Byte)).toBe(request)
  })
})
