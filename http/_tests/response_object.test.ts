import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { type ActionResult, Catch, type ErrorHandler, Router, version } from '../index.js'
import { constraints, createWebApplication } from '../platform/fastify/index.js'
import { firstMismatch, patterned } from './patterned.js'

const BYTES = patterned(0, 1000)

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice())
      controller.close()
    },
  })
}

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
  routes
    .get('/teapot')
    .catchBy([TeapotCatcher])
    .handler(() => {
      throw new ErrTeapot()
    })
  // Timed, so a request left unanswered fails as Fastify's 503 rather than as a hung test.
  routes
    .get('/consumed-context')
    .timeout(1_000)
    .handler(async ctx => {
      const response = new Response('read already')
      await response.text()

      try {
        return ctx.body(response)
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
    const res = await app.fetch('/answers/json')

    expect(res.status).toBe(201)
    expect(res.headers.get('x-answer')).toBe('yes')
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('streams the body of a Response built around a stream, with its status and headers', async () => {
    const res = await app.fetch('/answers/stream')

    expect(res.status).toBe(201)
    expect(res.headers.get('x-answer')).toBe('yes')
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body.length).toBe(BYTES.length)
    expect(firstMismatch(body, 0)).toBe(-1)
  })

  it('leaves a 206 a handler wrote itself exactly as written', async () => {
    const res = await app.fetch('/answers/partial')

    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-4/1000')
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BYTES.slice(0, 5))
  })

  it('sends a redirect with its Location, no body and no Content-Type', async () => {
    const res = await app.fetch('/answers/redirect')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('http://localhost/elsewhere')
    expect(res.headers.get('content-type')).toBeNull()
    expect(await res.text()).toBe('')
  })

  it('sends a 304 with its validator and no body', async () => {
    const res = await app.fetch('/answers/not-modified')

    expect(res.status).toBe(304)
    expect(res.headers.get('etag')).toBe('"v1"')
    expect(await res.text()).toBe('')
  })

  it("sends every cookie: the Response's own and the one the handler set on the context", async () => {
    const res = await app.fetch('/answers/cookies')

    const cookies = res.headers.getSetCookie().map(cookie => cookie.split(';')[0])
    expect(cookies).toEqual(expect.arrayContaining(['session=c3', 'theme=dark', 'lang=pt']))
    expect(cookies).toHaveLength(3)
  })

  it('answers a Response from an error handler with its own status, headers and body', async () => {
    const res = await app.fetch('/answers/teapot')

    expect(res.status).toBe(418)
    expect(res.headers.get('x-teapot')).toBe('yes')
    expect(await res.text()).toBe('short and stout')
  })

  it('answers 500 for a Response whose body was already read, rather than an empty success', async () => {
    const res = await app.fetch('/answers/consumed')

    expect(res.status).toBe(500)
  })

  it('leaves the context unanswered when ctx.body(...) refuses a Response, so the handler can answer otherwise', async () => {
    const res = await app.fetch('/answers/consumed-context')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ fallback: true })
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
      const [get, head] = await Promise.all([app.fetch(path), app.fetch(path, { method: 'HEAD' })])

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
    const res = await app.fetch('/versioned', { headers: { 'accept-version': '1.x' } })

    expect(await res.text()).toBe('v1')
    const vary = (res.headers.get('vary') ?? '').split(',').map(name => name.trim().toLowerCase())
    expect(vary).toEqual(expect.arrayContaining(['accept-version', 'accept-language']))
  })
})
