import { request as httpRequest } from 'node:http'
import { createGunzip, gunzipSync } from 'node:zlib'

import { KiB } from '@caffeinejs/std/bytes'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import { node } from '../../platform/node/node.js'
import { Attachment } from '../attachment/attachment.js'
import { ErrHTTPNotFound } from '../error/http.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { compress, compression } from './compress.js'
import { decodeAs, send, type WireReply } from './compress.testkit.js'
import { isCompressible } from './negotiate.js'

/**
 * `compression()` in the situations an application meets it, over a socket under `node()`: an API, downloads that
 * resume, revalidation, feeds, and many requests at once.
 */

type AnyRouter = Router<any, any, any, any, any>

const apps: { close(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close().catch(() => undefined)))
})

async function listen(app: ReturnType<typeof createWebApplication>, ...routers: AnyRouter[]): Promise<string> {
  const built = app.mount(...routers)
  apps.push(built)
  const { address } = await built.run({ host: '127.0.0.1', port: 0 })
  return `http://127.0.0.1:${address!.port}`
}

function decoded(reply: WireReply): Buffer {
  return decodeAs(reply.headers['content-encoding'], reply.body)
}

const app = () => createWebApplication({ adapter: node() })

describe('a JSON API under compression()', () => {
  const PETS = Array.from({ length: 200 }, (_, id) => ({ id, name: `pet ${id}`, tags: ['dog', 'friendly'] }))

  function api(): AnyRouter {
    const router = new Router('/pets')
    router.get('/').handler(() => PETS)
    router.get('/:id').handler(ctx => {
      const pet = PETS[Number(ctx.req.param('id'))]
      if (pet === undefined) {
        throw new ErrHTTPNotFound('No such pet')
      }
      return pet
    })
    router
      .post('/')
      .status(201)
      .handler(ctx => {
        ctx.header('location', '/pets/200')
        return { id: 200, ...(ctx.req.body() as object) }
      })
    return router
  }

  it('compresses the list, and leaves the small answers identity while still varying on Accept-Encoding', async () => {
    const origin = await listen(app().with(compression()), api())
    const headers = { 'accept-encoding': 'br, gzip' }

    const list = await send(origin, '/pets', { headers })
    const one = await send(origin, '/pets/7', { headers })
    const missing = await send(origin, '/pets/999', { headers })
    const created = await send(origin, '/pets', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ name: 'new' })),
    })

    expect(list.headers['content-encoding']).toBe('br')
    expect(JSON.parse(decoded(list).toString())).toEqual(PETS)

    expect(one.headers['content-encoding']).toBe(undefined)
    expect(one.headers.vary).toBe(undefined)
    expect(JSON.parse(one.body.toString())).toEqual(PETS[7])

    expect(missing.status).toBe(404)
    expect(missing.headers['content-encoding']).toBe(undefined)

    expect(created.status).toBe(201)
    expect(created.headers.location).toBe('/pets/200')
    expect(JSON.parse(decoded(created).toString())).toEqual({ id: 200, name: 'new' })
  })
})

describe('a download under compression()', () => {
  const CONTENT = Buffer.from(Array.from({ length: 8 * KiB }, (_, i) => `line ${i}\n`).join(''))

  function download(): AnyRouter {
    return new Router('/report.txt')
      .get('/')
      .handler(() => Attachment(CONTENT, { name: 'report.txt', type: 'text/plain', etag: '"r1"' }))
  }

  it('compresses the whole file, and resumes from identity bytes', async () => {
    const origin = await listen(app().with(compression()), download())

    const whole = await send(origin, '/report.txt', { headers: { 'accept-encoding': 'gzip' } })
    const resumed = await send(origin, '/report.txt', { headers: { 'accept-encoding': 'gzip', range: 'bytes=1000-' } })

    expect(whole.headers['content-encoding']).toBe('gzip')
    expect(whole.headers.etag).toBe('"r1"')
    expect(whole.headers['accept-ranges']).toBe(undefined)
    expect(gunzipSync(whole.body)).toEqual(CONTENT)

    expect(resumed.status).toBe(206)
    expect(resumed.headers['content-encoding']).toBe(undefined)
    expect(resumed.body).toEqual(CONTENT.subarray(1000))
  })

  it("resumes from identity bytes on the route's tag", async () => {
    const origin = await listen(app().with(compression()), download())

    const res = await send(origin, '/report.txt', {
      headers: { 'accept-encoding': 'gzip', range: 'bytes=1000-', 'if-range': '"r1"' },
    })

    expect(res.status).toBe(206)
    expect(res.headers['content-encoding']).toBe(undefined)
    expect(res.body).toEqual(CONTENT.subarray(1000))
  })

  it("revalidates the compressed answer with a 304 that carries the route's tag, as the route built it", async () => {
    const origin = await listen(app().with(compression()), download())

    const first = await send(origin, '/report.txt', { headers: { 'accept-encoding': 'br' } })
    const again = await send(origin, '/report.txt', {
      headers: { 'accept-encoding': 'br', 'if-none-match': first.headers.etag as string },
    })

    expect(first.headers.etag).toBe('"r1"')
    expect(again.status).toBe(304)
    expect(again.headers.etag).toBe('"r1"')
    expect(again.headers.vary).toBe(undefined)
    expect(again.body.byteLength).toBe(0)
  })
})

describe('feeds under compression()', () => {
  it('delivers each record of an NDJSON feed decoded before the next is written', async () => {
    const encoder = new TextEncoder()
    const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
    const feed = new Router('/feed').get('/').handler(ctx => {
      ctx.header('content-type', 'application/x-ndjson')
      let n = 0
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (n === 3) {
            controller.close()
            return
          }
          if (n > 0) {
            await gates[n - 1]!.promise
          }
          controller.enqueue(encoder.encode(`${JSON.stringify({ n })}\n`))
          n++
        },
      })
    })
    const origin = await listen(
      app().with(
        compression(c => c.compressible(type => isCompressible(type) || type.startsWith('application/x-ndjson'))),
      ),
      feed,
    )

    let coding: string | undefined
    const records = await new Promise<string[]>((resolve, reject) => {
      const seen: string[] = []
      httpRequest(`${origin}/feed`, { headers: { 'accept-encoding': 'gzip' } }, res => {
        coding = res.headers['content-encoding']
        const gunzip = createGunzip()
        let text = ''
        gunzip.on('data', (chunk: Buffer) => {
          text += chunk.toString()
          const lines = text.split('\n')
          text = lines.pop()!
          for (const line of lines) {
            seen.push(line)
            // The next record is written only once this one has arrived, decoded.
            gates[seen.length - 1]?.resolve()
          }
        })
        gunzip.on('end', () => resolve(seen))
        res.pipe(gunzip)
      })
        .on('error', reject)
        .end()
    })

    expect(coding).toBe('gzip')
    expect(records).toEqual(['{"n":0}', '{"n":1}', '{"n":2}'])
  })

  it('leaves server-sent events identity, so each arrives as sent', async () => {
    const events = new Router('/events').get('/').handler(ctx => {
      ctx.header('content-type', 'text/event-stream')
      return new Response(new Blob(['data: one\n\n', 'data: two\n\n']).stream())
    })
    const origin = await listen(app().with(compression()), events)

    const res = await send(origin, '/events', { headers: { 'accept-encoding': 'gzip' } })

    expect(res.headers['content-encoding']).toBe(undefined)
    expect(res.body.toString()).toBe('data: one\n\ndata: two\n\n')
  })
})

describe('routers that decide for themselves', () => {
  it('compresses /api, leaves /health alone with compress(false), and leaves a router outside the plugin alone', async () => {
    const BODY = { items: 'x'.repeat(4 * KiB) }
    const api = new Router('/api').with(compression())
    api.get('/').handler(() => BODY)
    api
      .get('/health')
      .extend(compress(false))
      .handler(() => BODY)
    const assets = new Router('/assets').get('/').handler(() => BODY)
    const origin = await listen(app(), api, assets)
    const headers = { 'accept-encoding': 'gzip' }

    expect((await send(origin, '/api', { headers })).headers['content-encoding']).toBe('gzip')
    expect((await send(origin, '/api/health', { headers })).headers['content-encoding']).toBe(undefined)
    expect((await send(origin, '/assets', { headers })).headers['content-encoding']).toBe(undefined)
  })
})

describe('many requests at once', () => {
  it('compresses answers above 16 KiB on the threadpool, 64 at a time, each intact', async () => {
    const BIG = { rows: Array.from({ length: 1200 }, (_, i) => ({ i, text: `row ${i} of the report` })) }
    const json = JSON.stringify(BIG)
    const big = new Router('/big').get('/').handler(() => BIG)
    const origin = await listen(app().with(compression()), big)
    const codings = ['zstd', 'br', 'gzip', 'deflate'] as const

    expect(Buffer.byteLength(json)).toBeGreaterThan(16 * KiB)

    const replies = await Promise.all(
      Array.from({ length: 64 }, (_, i) => send(origin, '/big', { headers: { 'accept-encoding': codings[i % 4]! } })),
    )

    replies.forEach((reply, i) => {
      expect(reply.headers['content-encoding']).toBe(codings[i % 4])
      expect(decoded(reply).toString()).toBe(json)
    })
  })
})
