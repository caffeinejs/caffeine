import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect as connectH2 } from 'node:http2'
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from 'node:zlib'

import { Second } from '@caffeinejs/std/duration'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type ActionResult, Catch, ErrHTTP, type ErrorHandler, Router, version } from '../index.js'
import { constraints, createWebApplication } from '../platform/fastify/index.js'
import { expectPatternedBody, streamOf } from './bodies.js'
import { patterned } from './patterned.js'

const BYTES = patterned(0, 1000)

const helpers = [
  ['badRequest', 400],
  ['notFound', 404],
  ['unprocessableEntity', 422],
  ['internalServerError', 500],
] as const

describe('a Response a handler returns is sent as its status, its headers and its body', () => {
  class ErrTeapot extends Error {}

  @Catch(ErrTeapot)
  class TeapotCatcher implements ErrorHandler<ErrTeapot> {
    handle(): ActionResult {
      return new Response('short and stout', { status: 418, headers: { 'x-teapot': 'yes' } })
    }
  }

  const routes = new Router('/answers')
  routes.get('/json').handler(() => Response.json({ ok: true }, { status: 201, headers: { 'x-answer': 'yes' } }))
  routes.get('/stream').handler(() => new Response(streamOf(BYTES), { status: 201, headers: { 'x-answer': 'yes' } }))
  // A route that serves ranges its own way writes the 206 itself; the adapter must leave it as it is.
  routes.get('/partial').handler(
    () =>
      new Response(BYTES.slice(0, 5), {
        status: 206,
        headers: { 'content-range': 'bytes 0-4/1000', 'content-type': 'application/pdf' },
      }),
  )
  routes.get('/redirect').handler(() => Response.redirect('http://localhost/elsewhere', 302))
  routes.get('/no-content').handler(() => new Response(null, { status: 204 }))
  routes.get('/not-modified').handler(() => new Response(null, { status: 304, headers: { etag: '"v1"' } }))
  routes.get('/cookies').handler(ctx => {
    ctx.cookie('session', 'c3')

    const headers = new Headers()
    headers.append('set-cookie', 'theme=dark')
    headers.append('set-cookie', 'lang=pt')

    return new Response('ok', { headers })
  })
  routes.get('/consumed').handler(async () => {
    const response = new Response('read already')
    await response.text()
    return response
  })
  routes.get('/helpers/:name').handler(ctx => {
    const name = ctx.req.param().name as (typeof helpers)[number][0]
    ctx[name](new Response(name, { headers: { 'x-kept': 'yes' } }))
  })
  routes.get('/err-http').handler(() => {
    throw new ErrHTTP(404, 'Not Found', { body: new Response('gone') })
  })
  routes.get('/created-via-body').handler(ctx => ctx.body(new Response('made', { status: 201 })))
  routes
    .get('/teapot')
    .catchBy([TeapotCatcher])
    .handler(() => {
      throw new ErrTeapot()
    })
  // Timed, so a request left unanswered fails as Fastify's 503 rather than as a hung test.
  routes
    .get('/consumed-context')
    .timeout(1 * Second)
    .handler(async ctx => {
      const response = new Response('read already')
      await response.text()

      try {
        return ctx.body(response)
      } catch {
        return { fallback: true }
      }
    })
  routes
    .get('/consumed-not-found')
    .timeout(1 * Second)
    .handler(async ctx => {
      const response = new Response('read already')
      await response.text()

      try {
        return ctx.notFound(response)
      } catch {
        return { fallback: true }
      }
    })

  const app = createWebApplication().mount(routes)

  beforeAll(async () => {
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  it('keeps the status, headers and JSON body of Response.json(...)', async () => {
    const res = await app.request('/answers/json')

    expect(res.status).toBe(201)
    expect(res.headers.get('x-answer')).toBe('yes')
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('streams the body of a Response built around a stream, with its status and headers', async () => {
    const res = await app.request('/answers/stream')

    expect(res.status).toBe(201)
    expect(res.headers.get('x-answer')).toBe('yes')
    await expectPatternedBody(res, 0, BYTES.length)
  })

  it('leaves a 206 a handler wrote itself exactly as written', async () => {
    const res = await app.request('/answers/partial')

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-4/1000')
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES.slice(0, 5))
  })

  it('sends a redirect with its Location, no body and no Content-Type', async () => {
    const res = await app.request('/answers/redirect')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('http://localhost/elsewhere')
    expect(res.headers.get('content-type')).toBeNull()
    expect(await res.text()).toBe('')
  })

  it('sends a 304 with its validator and no body', async () => {
    const res = await app.request('/answers/not-modified')

    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe('"v1"')
    expect(await res.text()).toBe('')
  })

  it("sends every cookie: the Response's own and the one the handler set on the context", async () => {
    const res = await app.request('/answers/cookies')

    const cookies = res.headers.getSetCookie().map(cookie => cookie.split(';')[0])
    expect(cookies).toEqual(expect.arrayContaining(['session=c3', 'theme=dark', 'lang=pt']))
    expect(cookies).toHaveLength(3)
  })

  it('answers a Response from an error handler with its own status, headers and body', async () => {
    const res = await app.request('/answers/teapot')

    expect(res.status).toBe(418)
    expect(res.headers.get('x-teapot')).toBe('yes')
    expect(await res.text()).toBe('short and stout')
  })

  it('answers 500 for a Response whose body was already read, rather than an empty success', async () => {
    const res = await app.request('/answers/consumed')

    expect(res.status).toBe(500)
  })

  it.each([
    ['ctx.body(...)', '/answers/consumed-context'],
    ['an error helper', '/answers/consumed-not-found'],
  ])(
    'leaves the context unanswered, its status untouched, when %s refuses a Response, so the handler can answer otherwise',
    async (_sender, path) => {
      const res = await app.request(path)

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ fallback: true })
    },
  )

  it.each(helpers)("keeps ctx.%s(...)'s status over a Response given as its body", async (name, status) => {
    const res = await app.request(`/answers/helpers/${name}`)

    expect(res.status).toBe(status)
    expect(res.headers.get('x-kept')).toBe('yes')
    expect(await res.text()).toBe(name)
  })

  it("keeps an ErrHTTP's status over a Response given as its body", async () => {
    const res = await app.request('/answers/err-http')

    expect(res.status).toBe(404)
    expect(await res.text()).toBe('gone')
  })

  it('sends a Response handed to ctx.body(...) as the whole answer, its status included', async () => {
    const res = await app.request('/answers/created-via-body')

    expect(res.status).toBe(201)
    expect(await res.text()).toBe('made')
  })

  describe('on HEAD', () => {
    it.each([
      ['Response.json(...)', '/answers/json', 201],
      ['a Response built around a stream', '/answers/stream', 201],
      ['a 206 the handler wrote', '/answers/partial', 206],
      ['a redirect', '/answers/redirect', 302],
      ['a 204', '/answers/no-content', 204],
      ['a 304', '/answers/not-modified', 304],
    ])('answers %s with the status and headers a GET gets, and no body', async (_kind, path, status) => {
      const [get, head] = await Promise.all([app.request(path), app.request(path, { method: 'HEAD' })])

      expect(head.status).toBe(status)
      expect(head.status).toBe(get.status)
      for (const name of ['content-type', 'x-answer', 'content-range', 'location', 'etag']) {
        expect(head.headers.get(name)).toBe(get.headers.get(name))
      }
      expect(await head.text()).toBe('')
    })
  })
})

describe("a Response's headers join the ones the server adds, rather than replacing them", () => {
  const versioned = new Router('/versioned').extend(version('1.0.0'))
  versioned.get('/').handler(() => new Response('v1', { headers: { vary: 'Accept-Language' } }))

  const app = createWebApplication()
    .with(() => constraints())
    .mount(versioned)

  beforeAll(async () => {
    await app.bootstrap()
  })

  afterAll(async () => {
    await app.close()
  })

  it("keeps the Vary a version constraint adds alongside the Response's own, so a cache keeps versions apart", async () => {
    const res = await app.request('/versioned', { headers: { 'accept-version': '1.x' } })

    expect(await res.text()).toBe('v1')
    const vary = (res.headers.get('vary') ?? '').split(',').map(name => name.trim().toLowerCase())
    expect(vary).toEqual(expect.arrayContaining(['accept-version', 'accept-language']))
  })
})

describe('a Response fetched from upstream and returned is sent as the bytes the handler holds', () => {
  const PLAIN = Buffer.from('region,total\nnorth,12\n'.repeat(400))
  const encoders: Record<string, (bytes: Buffer) => Buffer> = {
    gzip: gzipSync,
    'x-gzip': gzipSync,
    deflate: deflateSync,
    br: brotliCompressSync,
    zstd: zstdCompressSync,
    // A coding fetch does not know: it hands the body over as it came, still gzip.
    'x-unknown': gzipSync,
    identity: bytes => bytes,
  }

  // An upstream answering compressed under its compressed length, with a header its Connection names hop-by-hop.
  function answerCompressed(req: IncomingMessage, res: ServerResponse) {
    const coding = req.url!.slice(1)
    const body = encoders[coding](PLAIN)
    res.writeHead(200, {
      'content-type': 'text/csv',
      ...(coding === 'identity' ? {} : { 'content-encoding': coding }),
      'content-length': body.length,
      connection: 'keep-alive, x-hop',
      'x-hop': '1',
    })
    res.end(body)
  }

  const upstream = createServer(answerCompressed)
  let upstreamOrigin: string

  const proxy = new Router('/proxy')
  proxy.get('/:coding').handler(ctx => fetch(`${upstreamOrigin}/${ctx.req.param().coding}`))
  proxy
    .get('/precompressed')
    .handler(
      () => new Response(gzipSync(PLAIN), { headers: { 'content-encoding': 'gzip', 'content-type': 'text/csv' } }),
    )

  const app = createWebApplication().mount(proxy)

  const key = readFileSync(new URL('./_testdata/tls/localhost.key', import.meta.url))
  const cert = readFileSync(new URL('./_testdata/tls/localhost.crt', import.meta.url))
  const secure = createWebApplication()
    .server(() => ({ factory: { http2: true, https: { key, cert } }, listener: { host: '127.0.0.1', port: 0 } }))
    .mount(new Router('/h2').get('/gzip').handler(() => fetch(`${upstreamOrigin}/gzip`)))

  beforeAll(async () => {
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address() as { port: number }
    upstreamOrigin = `http://127.0.0.1:${address.port}`
    await app.bootstrap()
    await secure.run()
  })

  afterAll(async () => {
    await secure.close()
    await app.close()
    await new Promise(resolve => upstream.close(resolve))
  })

  /** Whether this runtime's `fetch` hands back `coding` decoded: what the proxied answer has to agree with. */
  async function fetchDecodes(coding: string): Promise<boolean> {
    const direct = await fetch(`${upstreamOrigin}/${coding}`)
    return Buffer.from(await direct.arrayBuffer()).equals(PLAIN)
  }

  it.each(['gzip', 'x-gzip', 'deflate', 'br', 'zstd', 'x-unknown'])(
    'labels a %s upstream body as fetch hands it over: decoded and unlabelled, or as sent and labelled',
    async coding => {
      const res = await app.request(`/proxy/${coding}`)
      const body = Buffer.from(await res.arrayBuffer())

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/csv')
      if (await fetchDecodes(coding)) {
        expect(body.equals(PLAIN)).toBe(true)
        expect(res.headers.get('content-encoding')).toBeNull()
        expect([null, String(PLAIN.length)]).toContain(res.headers.get('content-length'))
      } else {
        expect(body.equals(encoders[coding](PLAIN))).toBe(true)
        expect(res.headers.get('content-encoding')).toBe(coding)
        expect(res.headers.get('content-length')).toBe(String(body.length))
      }
    },
  )

  it('keeps the length of an upstream body sent with no coding, which fetch hands over as it came', async () => {
    const res = await app.request('/proxy/identity')

    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('content-length')).toBe(String(PLAIN.length))
    expect(Buffer.from(await res.arrayBuffer()).equals(PLAIN)).toBe(true)
  })

  it("leaves the upstream's hop-by-hop headers behind, the ones its Connection names included", async () => {
    const res = await app.request('/proxy/gzip')

    expect(res.headers.get('x-hop')).toBeNull()
    expect(res.headers.get('keep-alive')).toBeNull()
    expect(res.headers.get('connection') ?? '').not.toContain('x-hop')
  })

  it('keeps the coding of a Response the handler built from bytes it compressed itself', async () => {
    const res = await app.request('/proxy/precompressed')

    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(Buffer.from(await res.arrayBuffer()).equals(gzipSync(PLAIN))).toBe(true)
  })

  it('answers a proxied upstream over HTTP/2, which refuses a Connection header', async () => {
    const answered = await new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const session = connectH2(secure.address!.origin, { ca: cert })
      session.on('error', reject)
      const stream = session.request({ ':path': '/h2/gzip' })
      const chunks: Buffer[] = []
      let status = 0
      stream.on('response', headers => (status = Number(headers[':status'])))
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        session.close()
        resolve({ status, body: Buffer.concat(chunks) })
      })
      stream.on('error', reject)
      stream.end()
    })

    expect(answered.status).toBe(200)
    expect(answered.body.equals(PLAIN)).toBe(true)
  })
})
