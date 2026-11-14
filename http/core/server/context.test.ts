import { newNoopLogger } from '@caffeinejs/application/logger'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWebApplication } from '../../application.js'
import { Router } from '../routing/programmatic/programmatic.js'

const routes = new Router('/c')
routes
  .get('/declared')
  .produces('text/csv')
  .header('x-api', '2')
  .handler(ctx => `${ctx.getHeader('content-type')}|${ctx.getHeader('x-api')}`)
routes.get('/response-case').handler(ctx => {
  ctx.header('X-A', '1')
  return { read: ctx.getHeader('x-a') }
})
routes.get('/request-case').handler(ctx => ({ trace: ctx.req.header('X-Trace') ?? null }))
routes.get('/appended').handler(ctx => {
  ctx.appendHeader('x-step', 'parse').appendHeader('x-step', 'render')
  return { step: ctx.getHeader('x-step') }
})
routes.get('/not-found').handler(ctx => ctx.notFound())
routes.get('/not-found-body').handler(ctx => ctx.notFound({ missing: 'pet' }))
routes.get('/redirect').handler(ctx => ctx.redirect('~/x'))
routes.get('/promise').handler(ctx => {
  try {
    ctx.body(Promise.resolve(1))
  } catch {
    // Refused with nothing sent: the handler can still answer.
  }
  return 'ok'
})
routes.get('/cookie').handler(ctx => ctx.cookie('a', 'b'))
routes.get('/body').handler(ctx => ctx.req.body())
routes.get('/status').handler(ctx => ctx.status(101))
routes.get('/config').handler(ctx => ({ same: ctx.config === ctx.config }))

const logged = vi.fn()
const app = createWebApplication()
  .logger(b => b.use({ ...newNoopLogger(), error: logged }))
  .basePath('/api')
  .mount(routes)

beforeAll(async () => {
  await app.bootstrap()
})

afterAll(async () => {
  await app.close()
})

async function get(path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`http://localhost/api/c${path}`, init))
}

async function problemCode(res: Response): Promise<string> {
  return ((await res.json()) as { code: string }).code
}

describe('Context', () => {
  it("reads the route's declared headers and content type before the handler writes", async () => {
    expect(await (await get('/declared')).text()).toBe('text/csv|2')
  })

  it('reads a response header in any case', async () => {
    expect(await (await get('/response-case')).json()).toEqual({ read: '1' })
  })

  it('reads a request header in any case', async () => {
    expect(await (await get('/request-case', { headers: { 'x-trace': 't-1' } })).json()).toEqual({ trace: 't-1' })
  })

  it('joins an appended header with a comma', async () => {
    expect(await (await get('/appended')).json()).toEqual({ step: 'parse, render' })
  })

  // The same problem a thrown ErrHTTPNotFound renders to, so one application answers errors in one shape.
  it('answers notFound() with the default problem', async () => {
    const res = await get('/not-found')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('vary')).toBe('Accept')
    expect(await problemCode(res)).toBe('ERR_HTTP_NOT_FOUND')
  })

  it('sends a body given to notFound() as it stands', async () => {
    const res = await get('/not-found-body')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ missing: 'pet' })
  })

  it('redirects ~/ under the base path', async () => {
    const res = await get('/redirect')

    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/api/x')
  })

  it('refuses a promise given to ctx.body, and lets the handler answer after', async () => {
    const res = await get('/promise')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it.each([
    ['/cookie', 'ERR_COOKIES_DISABLED', 'Cannot set cookies'],
    ['/body', 'ERR_CONFIGURATION', 'Cannot read the request body'],
    ['/status', 'ERR_CONFIGURATION', 'Cannot set status "101"'],
  ])('answers %s, which the fetch application refuses, with a 500 and logs %s', async (path, code, message) => {
    logged.mockClear()

    const res = await get(path)

    expect(res.status).toBe(500)
    expect(await problemCode(res)).toBe('ERR_INTERNAL')
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ code, message: expect.stringContaining(message) }) }),
      expect.any(String),
    )
  })

  // Log lines carry the id, so they read the same on either server.
  it('numbers request ids as Fastify does', async () => {
    const counted = createWebApplication().mount(new Router('/id').get('/').handler(ctx => ctx.req.id))
    await counted.bootstrap()

    try {
      const ids: string[] = []
      for (let i = 0; i < 11; i++) {
        ids.push(await (await counted.fetch(new Request('http://localhost/id'))).text())
      }

      expect(ids.at(-1)).toBe('req-b')
    } finally {
      await counted.close()
    }
  })

  it('keeps one config snapshot for the context', async () => {
    expect(await (await get('/config')).json()).toEqual({ same: true })
  })
})

describe('ContextRequest behind a proxy and with a request ID', () => {
  const opened: Array<{ close(): Promise<void> }> = []

  afterAll(async () => {
    await Promise.all(opened.map(app => app.close()))
  })

  async function serve(settings: object) {
    const probe = new Router('/p')
    probe.get('/').handler(ctx => ({ host: ctx.req.host, protocol: ctx.req.protocol, id: ctx.req.id }))

    const served = createWebApplication()
      .logger(b => b.use(newNoopLogger()))
      .server(() => settings as never)
      .mount(probe)
    opened.push(served)
    await served.bootstrap()

    return served
  }

  async function seen(res: Response): Promise<{ host: string; protocol: string; id: string }> {
    return (await res.json()) as { host: string; protocol: string; id: string }
  }

  const forwarded = { 'x-forwarded-host': 'a.example, b.example', 'x-forwarded-proto': 'http, HTTPS' }

  it('ignores the forwarding headers without trustProxy', async () => {
    const served = await serve({})
    const res = await served.request('/p', {
      headers: { 'x-forwarded-host': 'a.example', 'x-forwarded-proto': 'https' },
    })

    expect(await seen(res)).toMatchObject({ host: 'localhost', protocol: 'http' })
  })

  it('reads the last entry of each forwarding header under trustProxy: true, the scheme lower-cased', async () => {
    const served = await serve({ trustProxy: true })

    expect(await seen(await served.request('/p', { headers: forwarded }))).toMatchObject({
      host: 'b.example',
      protocol: 'https',
    })
  })

  // A runtime that says nothing of the peer: `true` trusts whoever it is.
  it('reads them under trustProxy: true on a request with no peer address', async () => {
    const served = await serve({ trustProxy: true })

    expect(await seen(await served.fetch(new Request('http://x/p', { headers: forwarded })))).toMatchObject({
      host: 'b.example',
      protocol: 'https',
    })
  })

  it('takes an empty forwarded host as absent', async () => {
    const served = await serve({ trustProxy: true })

    expect(await seen(await served.request('/p', { headers: { 'x-forwarded-host': '' } }))).toMatchObject({
      host: 'localhost',
    })
  })

  it('reads the host of the request URL when no Host header names one', async () => {
    const served = await serve({})

    expect(await seen(await served.fetch(new Request('http://x/p')))).toMatchObject({ host: 'x' })
  })

  it('takes the request ID from the requestIDHeader the request carries', async () => {
    const served = await serve({ requestIDHeader: 'x-request-id' })

    expect(await seen(await served.request('/p', { headers: { 'x-request-id': 'edge-91' } }))).toMatchObject({
      id: 'edge-91',
    })
  })

  it('numbers a request that does not carry the requestIDHeader', async () => {
    const served = await serve({ requestIDHeader: 'x-request-id' })

    expect(await seen(await served.request('/p'))).toMatchObject({ id: 'req-1' })
  })

  it('numbers a request whose requestIDHeader is empty', async () => {
    const served = await serve({ requestIDHeader: 'x-request-id' })

    expect(await seen(await served.request('/p', { headers: { 'x-request-id': '' } }))).toMatchObject({ id: 'req-1' })
  })
})

describe('Context while onSend runs', () => {
  const sending = createWebApplication()
    .hook('onSend', ctx => {
      ctx.status(201)
      ctx.body('replaced')
    })
    .mount(new Router('/s').get('/').handler(() => 'answer'))

  beforeAll(async () => {
    await sending.bootstrap()
  })

  afterAll(async () => {
    await sending.close()
  })

  // The head is still open while onSend runs; the answer is not: a new body goes through the payload onSend returns.
  it('takes a status and refuses a new body', async () => {
    const res = await sending.request('/s')

    expect(res.status).toBe(201)
    expect(await res.text()).toBe('answer')
  })
})
