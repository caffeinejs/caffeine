import { newNoopLogger } from '@caffeinejs/application/logger'
import { $t } from '@caffeinejs/application/schema'
import { afterAll, assert, beforeAll, describe, expect, it, vi } from 'vitest'

import { createWebApplication } from '../../application.js'
import type { IContext, ServerContext } from '../../context.js'
import { bodyAsStream } from '../../decorators/body_as_stream.js'
import { Catch } from '../../decorators/index.js'
import type { ActionResult } from '../../response.js'
import { CookieSigner, type CookieUnsignResult } from '../cookie/signer.js'
import { ErrConfiguration } from '../error/common.js'
import type { ErrorHandler } from '../error/handler.js'
import { ErrHTTPBadRequest } from '../error/http.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { withholdValidators } from './context.js'

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
  ctx.header('x-step', 'parse', { append: true }).header('x-step', 'render', { append: true })
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
routes.get('/status').handler(ctx => ctx.status(101))
routes.get('/config').handler(ctx => ({ same: ctx.config === ctx.config }))
routes.get('/plain-fetch').handler(() => 'ok')
routes.get('/fetch-peer').handler(ctx => ctx.server.remoteAddress ?? 'no peer')

const inspectServer =
  vi.fn<(server: ServerContext, repeated: ServerContext, raw: unknown, platform: IContext['platform']) => void>()
routes.get('/server').handler(ctx => {
  inspectServer(ctx.server, ctx.server, ctx.req.raw, ctx.platform)
  return ctx.server.remoteAddress ?? 'no peer'
})

// The body shared between `ctx.req.raw` and the route, read in either order. A plain router types `raw` for every
// application; the fetch application's is the web `Request`.
const rawOf = (ctx: { req: { raw: unknown } }): Request => ctx.req.raw as Request
let seenRaw: Request | undefined
routes
  .post('/raw-headers')
  .hook('onRequest', ctx => void rawOf(ctx).headers)
  .handler(ctx => {
    seenRaw = rawOf(ctx)
    return { body: ctx.req.body() }
  })
routes
  .post('/raw-read')
  .hook('onRequest', async ctx => void (await rawOf(ctx).text()))
  .handler(() => 'never')
routes
  .post('/raw-read-stream')
  .extend(bodyAsStream())
  .hook('onRequest', async ctx => void (await rawOf(ctx).text()))
  .handler(() => 'never')
routes
  .post('/raw-locked-stream')
  .extend(bodyAsStream())
  .hook('onRequest', ctx => void rawOf(ctx).body?.getReader())
  .handler(() => 'never')

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

  it.each([['/status', 'ERR_CONFIGURATION', 'Cannot set status "101"']])(
    'answers %s, which the fetch application refuses, with a 500 and logs %s',
    async (path, code, message) => {
      logged.mockClear()

      const res = await get(path)

      expect(res.status).toBe(500)
      expect(await problemCode(res)).toBe('ERR_INTERNAL')
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.objectContaining({ code, message: expect.stringContaining(message) }) }),
        expect.any(String),
      )
    },
  )

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

  it.each([
    ['/plain-fetch', 'ok'],
    ['/fetch-peer', 'no peer'],
  ])('returns a synchronous Fetch response from %s', async (path, body) => {
    const response = app.fetch(new Request(`http://localhost/api/c${path}`))

    expect(response).toBeInstanceOf(Response)
    expect(await (await response).text()).toBe(body)
  })

  it('keeps one server view per raw Fetch request and preserves the runtime arguments', async () => {
    inspectServer.mockClear()
    const request = new Request('http://localhost/api/c/server')
    const nextRequest = new Request(request)
    const env = { region: 'eu' }
    const host = { waitUntil: vi.fn() }

    const response = app.fetch(request, env, host)
    const nextResponse = app.fetch(nextRequest)

    expect(response).toBeInstanceOf(Response)
    expect(await (await response).text()).toBe('no peer')
    expect(await (await nextResponse).text()).toBe('no peer')
    expect(inspectServer).toHaveBeenCalledTimes(2)

    const [server, repeated, raw, platform] = inspectServer.mock.calls[0]!
    const [nextServer, nextRepeated] = inspectServer.mock.calls[1]!
    expect(server).toBe(repeated)
    expect(nextServer).toBe(nextRepeated)
    expect(nextServer).not.toBe(server)
    expect(server.remoteAddress).toBeUndefined()
    expect('waitUntil' in server).toBe(false)
    expect(raw).toBe(request)
    assert(platform.name === 'fetch')
    expect(platform.runtime).toHaveLength(2)
    expect(platform.runtime[0]).toBe(env)
    expect(platform.runtime[1]).toBe(host)
    expect(host.waitUntil).not.toHaveBeenCalled()
  })

  it('exposes the loopback peer and local registration on an injected request', async () => {
    inspectServer.mockClear()

    const response = await app.request('/api/c/server')

    expect(await response.text()).toBe('127.0.0.1')
    expect(inspectServer).toHaveBeenCalledTimes(1)
    const [server, repeated] = inspectServer.mock.calls[0]!
    expect(server).toBe(repeated)
    expect(typeof server.waitUntil).toBe('function')
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

describe('the body shared with ctx.req.raw', () => {
  function post(path: string): { request: Request; answer: Response | Promise<Response> } {
    const request = new Request(`http://localhost/api/c${path}`, {
      method: 'POST',
      body: 'ping',
      headers: { 'content-type': 'text/plain' },
    })
    return { request, answer: app.fetch(request) }
  }

  it('leaves the body to the route when a hook reads only the headers of ctx.req.raw', async () => {
    const { request, answer } = post('/raw-headers')

    expect(await (await answer).json()).toEqual({ body: 'ping' })
    // The runtime's own Request, read by the route: what a runtime API keyed on it still finds.
    expect(seenRaw).toBe(request)
  })

  it.each(['/raw-read', '/raw-read-stream', '/raw-locked-stream'])(
    'answers %s, whose body a hook read first, with a 500 and logs ERR_REQUEST_BODY_CONSUMED',
    async path => {
      logged.mockClear()

      const res = await post(path).answer

      expect(res.status).toBe(500)
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.objectContaining({ code: 'ERR_REQUEST_BODY_CONSUMED' }) }),
        expect.any(String),
      )
    },
  )
})

describe('cookies', () => {
  const S = 's'.repeat(32)
  const opened: Array<{ close(): Promise<void> }> = []
  const cookieLogged = vi.fn()

  afterAll(async () => {
    await Promise.all(opened.map(served => served.close()))
  })

  type Configure = (app: ReturnType<typeof createWebApplication>) => ReturnType<typeof createWebApplication>

  // Any router, as `mount` takes it: the route types each carries are not under test here.
  async function serve(router: Router<any, any, any, any, any>, configure: Configure = app => app) {
    cookieLogged.mockClear()
    const served = configure(
      createWebApplication().logger(b => b.use({ ...newNoopLogger(), error: cookieLogged })),
    ).mount(router)
    opened.push(served)
    await served.bootstrap()

    return served
  }

  it('writes each cookie set as its own Set-Cookie line, in order', async () => {
    const served = await serve(
      new Router('/k').get('/').handler(ctx => {
        ctx.cookie('a', 'b')
        ctx.cookie('c', 'd')
        return 'ok'
      }),
    )

    const res = await served.request('/k')

    expect(res.headers.getSetCookie()).toEqual(['a=b; Path=/; SameSite=Lax', 'c=d; Path=/; SameSite=Lax'])
  })

  it('writes a deletion as an expired, empty cookie', async () => {
    const served = await serve(
      new Router('/k').get('/').handler(ctx => {
        ctx.deleteCookie('a')
        return 'ok'
      }),
    )

    const res = await served.request('/k')

    expect(res.headers.getSetCookie()).toEqual([
      'a=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax',
    ])
  })

  it('writes the cookies after a Set-Cookie the route declared', async () => {
    const served = await serve(
      new Router('/k')
        .get('/')
        .header('set-cookie', 'x=1')
        .handler(ctx => {
          ctx.cookie('a', 'b')
          return 'ok'
        }),
    )

    const res = await served.request('/k')

    expect(res.headers.getSetCookie()).toEqual(['x=1', 'a=b; Path=/; SameSite=Lax'])
  })

  it('reads the cookies the request carries', async () => {
    const served = await serve(
      new Router('/k').get('/').handler(ctx => ({ one: ctx.req.cookie('a'), all: ctx.req.cookie() })),
    )

    const res = await served.request('/k', { headers: { cookie: 'a=1; b=2' } })

    expect(await res.json()).toEqual({ one: '1', all: { a: '1', b: '2' } })
  })

  it('signs a cookie, and verifies it when it comes back', async () => {
    const router = new Router('/k')
    router.get('/set').handler(ctx => {
      ctx.cookie('s', 'v', { signed: true })
      return 'ok'
    })
    router.get('/read').handler(async ctx => {
      const raw = ctx.req.cookie('s')!
      return {
        signed: await ctx.req.signedCookie('s'),
        valid: (await ctx.req.unsignCookie(raw)).valid,
      }
    })
    const served = await serve(router, app => app.cookie(k => k.secret(S)))

    const lines = (await served.request('/k/set')).headers.getSetCookie()
    expect(lines).toHaveLength(1)
    const value = lines[0]!.slice('s='.length, lines[0]!.indexOf(';'))

    const read = await served.request('/k/read', { headers: { cookie: `s=${value}` } })
    expect(await read.json()).toEqual({ signed: 'v', valid: true })

    const tampered = `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`
    const forged = await served.request('/k/read', { headers: { cookie: `s=${tampered}` } })
    expect(await forged.json()).toEqual({ signed: false, valid: false })
  })

  it('writes the cookies ahead of every onSend hook', async () => {
    let seen: string | undefined
    const served = await serve(
      new Router('/k').get('/').handler(ctx => {
        ctx.cookie('a', 'b')
        return 'ok'
      }),
      app =>
        app.hook('onSend', ctx => {
          seen = ctx.getHeader('set-cookie')
        }),
    )

    await served.request('/k')

    expect(seen).toBe('a=b; Path=/; SameSite=Lax')
  })

  it('writes a cookie a root hook set on a request no route matched', async () => {
    const served = await serve(
      new Router('/k').get('/').handler(() => 'ok'),
      app =>
        app.hook('onRequest', ctx => {
          ctx.cookie('m', '1')
        }),
    )

    const res = await served.request('/nowhere')

    expect(res.status).toBe(404)
    expect(res.headers.getSetCookie()).toEqual(['m=1; Path=/; SameSite=Lax'])
  })

  it('writes an unsigned cookie an onSend hook sets after the others went out', async () => {
    const served = await serve(
      new Router('/k').get('/').handler(() => 'ok'),
      app =>
        app.hook('onSend', ctx => {
          ctx.cookie('late', '1')
        }),
    )

    const res = await served.request('/k')

    expect(res.headers.getSetCookie()).toEqual(['late=1; Path=/; SameSite=Lax'])
  })

  it('refuses a signed cookie an onSend hook sets: nothing would sign it', async () => {
    const served = await serve(
      new Router('/k').get('/').handler(() => 'ok'),
      app =>
        app
          .cookie(k => k.secret(S))
          .hook('onSend', ctx => {
            ctx.cookie('late', '1', { signed: true })
          }),
    )

    const res = await served.request('/k')

    expect(res.status).toBe(500)
    expect(await problemCode(res)).toBe('ERR_INTERNAL')
    expect(cookieLogged).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ code: 'ERR_COOKIE_TOO_LATE' }) }),
      expect.any(String),
    )
  })

  describe('turned off', () => {
    it('fails a write, naming the setting', async () => {
      const served = await serve(
        new Router('/k').get('/').handler(ctx => {
          ctx.cookie('a', 'b')
          return 'ok'
        }),
        app => app.cookie(k => k.enabled(false)),
      )

      const res = await served.request('/k')

      expect(res.status).toBe(500)
      expect(await problemCode(res)).toBe('ERR_INTERNAL')
      expect(cookieLogged).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.objectContaining({
            code: 'ERR_COOKIES_DISABLED',
            message: expect.stringMatching(
              /^Cannot set cookies: cookies are disabled on this server[\s\S]*\.cookie\(k => k\.enabled\(true\)\)/,
            ),
          }),
        }),
        expect.any(String),
      )
    })

    // As on Fastify: the read is a promise, and it rejects rather than throws.
    it('rejects a signed read', async () => {
      const served = await serve(
        new Router('/k').get('/').handler(async ctx =>
          ctx.req.signedCookie('a').then(
            () => 'read',
            (err: Error) => err.name,
          ),
        ),
        app => app.cookie(k => k.enabled(false)),
      )

      expect(await (await served.request('/k')).text()).toBe('ErrCookiesDisabled')
    })
  })

  it('sends the cookies a handler set before it threw with the error answer', async () => {
    const served = await serve(
      new Router('/k').get('/').handler(ctx => {
        ctx.cookie('a', 'b')
        throw new ErrHTTPBadRequest()
      }),
    )

    const res = await served.request('/k')

    expect(res.status).toBe(400)
    expect(res.headers.getSetCookie()).toEqual(['a=b; Path=/; SameSite=Lax'])
  })

  // As a handler's throw is: the error chain answers it, with a cookie pass of its own. The failed batch goes with the
  // answer it was for.
  describe('when the cookies cannot be signed', () => {
    class ErrSigning extends Error {}

    class Failing extends CookieSigner {
      sign(): Promise<string> {
        return Promise.reject(new ErrSigning('boom'))
      }

      unsign(): Promise<CookieUnsignResult> {
        return Promise.resolve({ valid: false, renew: false, value: null })
      }
    }

    @Catch(ErrSigning)
    class Recovering implements ErrorHandler<ErrSigning> {
      handle(ctx: IContext, err: ErrSigning): ActionResult {
        ctx.cookie('recovered', '1')
        return { caught: err.message }
      }
    }

    @Catch(ErrSigning)
    class SigningAgain implements ErrorHandler<ErrSigning> {
      handle(ctx: IContext): ActionResult {
        ctx.cookie('again', '1', { signed: true })
        return { caught: true }
      }
    }

    // An unsigned cookie beside it: the whole batch goes with the answer it was for.
    const signing = (ctx: IContext) => {
      ctx.cookie('plain', '1')
      ctx.cookie('s', 'v', { signed: true })
      return 'ok'
    }

    it('hands the failure to the error chain, whose answer goes out with its own cookies', async () => {
      const onError = vi.fn()
      const served = await serve(new Router('/k').catchBy([Recovering]).get('/').handler(signing), app =>
        app.cookie(k => k.signer(new Failing())).hook('onError', onError),
      )

      const res = await served.request('/k')

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ caught: 'boom' })
      expect(res.headers.getSetCookie()).toEqual(['recovered=1; Path=/; SameSite=Lax'])
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ message: 'boom' }))
    })

    it('answers the default problem when nothing catches it', async () => {
      const served = await serve(new Router('/k').get('/').handler(signing), app =>
        app.cookie(k => k.signer(new Failing())),
      )

      const res = await served.request('/k')

      expect(res.status).toBe(500)
      expect(await problemCode(res)).toBe('ERR_INTERNAL')
      expect(res.headers.getSetCookie()).toEqual([])
      // The error chain answered it, not the last resort of an answer whose cookies failed twice.
      expect(cookieLogged).not.toHaveBeenCalledWith(expect.anything(), 'Cannot write the response cookies')
    })

    it("answers a plain 500 when the error answer's own cookies cannot be signed either", async () => {
      const onError = vi.fn()
      const served = await serve(new Router('/k').catchBy([SigningAgain]).get('/').handler(signing), app =>
        app.cookie(k => k.signer(new Failing())).hook('onError', onError),
      )

      const res = await served.request('/k')

      expect(res.status).toBe(500)
      expect(await problemCode(res)).toBe('ERR_INTERNAL')
      expect(res.headers.getSetCookie()).toEqual([])
      expect(onError).toHaveBeenCalledTimes(1)
      expect(cookieLogged).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.objectContaining({ message: 'boom' }) }),
        'Cannot write the response cookies',
      )
    })
  })

  it('refuses a cookie once the answer has gone out', async () => {
    let done!: () => void
    const finished = new Promise<void>(resolve => {
      done = resolve
    })
    const served = await serve(
      new Router('/k').get('/').handler(() => 'ok'),
      app =>
        app
          .hook('onResponse', ctx => {
            ctx.cookie('late', '1')
          })
          .hook('onResponse', () => done()),
    )

    await (await served.request('/k')).text()
    await finished

    expect(cookieLogged).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ code: 'ERR_COOKIE_TOO_LATE' }) }),
      'onResponse hook failed',
    )
  })

  describe("secure: 'auto'", () => {
    const auto = () =>
      new Router('/k').get('/').handler(ctx => {
        ctx.cookie('a', 'b', { secure: 'auto' })
        return 'ok'
      })

    it('marks the cookie Secure behind a trusted proxy that says the request came over HTTPS', async () => {
      const served = await serve(auto(), app => app.server(() => ({ trustProxy: true }) as never))

      const res = await served.request('/k', { headers: { 'x-forwarded-proto': 'https' } })

      expect(res.headers.getSetCookie()).toEqual(['a=b; Path=/; Secure; SameSite=Lax'])
    })

    it('ignores the forwarded protocol of a proxy the server does not trust', async () => {
      const served = await serve(auto())

      const res = await served.request('/k', { headers: { 'x-forwarded-proto': 'https' } })

      expect(res.headers.getSetCookie()).toEqual(['a=b; Path=/; SameSite=Lax'])
    })
  })
})

describe('response headers', () => {
  let captured: Record<string, string | string[]> | undefined
  let afterSent: string | undefined
  let sent!: () => void
  const responded = new Promise<void>(resolve => {
    sent = resolve
  })

  const headers = new Router('/h')
  headers
    .get('/listed')
    .hook('onSend', ctx => {
      captured = ctx.getHeaders()
    })
    .handler(ctx => {
      ctx.header('x-a', 'a')
      ctx.header('x-b', '1', { append: true }).header('x-b', '2', { append: true })
      return 'ok'
    })
  headers
    .get('/copied')
    .hook('onSend', ctx => {
      ctx.getHeaders()['x-a'] = 'changed'
    })
    .handler(ctx => {
      ctx.header('x-a', 'a')
      return 'ok'
    })
  headers
    .get('/removed')
    .hook('onSend', ctx => {
      ctx.removeHeader('X-Gone')
    })
    .handler(ctx => {
      ctx.header('x-gone', '1')
      return 'ok'
    })
  headers
    .get('/late')
    .hook('onResponse', ctx => {
      ctx.removeHeader('x-a')
      afterSent = ctx.getHeader('x-a')
      sent()
    })
    .handler(ctx => {
      ctx.header('x-a', 'a')
      return 'ok'
    })

  const served = createWebApplication()
    .logger(b => b.use(newNoopLogger()))
    .mount(headers)

  beforeAll(async () => {
    await served.bootstrap()
  })

  afterAll(async () => {
    await served.close()
  })

  it('lists every header a route wrote through getHeaders, a list value as its list', async () => {
    await (await served.request('/h/listed')).text()

    expect(captured?.['x-a']).toBe('a')
    expect(captured?.['x-b']).toEqual(['1', '2'])
  })

  // What getHeaders hands out is a copy: a write to it would otherwise reach the answer past the checks `header` makes.
  it('does not send a write to what getHeaders returned', async () => {
    const res = await served.request('/h/copied')

    expect(res.headers.get('x-a')).toBe('a')
  })

  it('takes a header off the answer with removeHeader, from onSend, in any case', async () => {
    const res = await served.request('/h/removed')

    expect(res.headers.get('x-gone')).toBe(null)
  })

  it('changes nothing with removeHeader once the answer has left', async () => {
    await (await served.request('/h/late')).text()
    await responded

    expect(afterSent).toBe('a')
  })
})

describe('withholdValidators', () => {
  const restores = new Map<string, () => void>()
  let restored: string | undefined

  const validators = new Router('/w')
  for (const [path, validated] of [
    ['/plain', false],
    ['/validated', true],
  ] as const) {
    const route = validators
      .get(path)
      .hook('onRequest', ctx => {
        restores.set(path, withholdValidators(ctx))
      })
      .hook('onSend', ctx => {
        restores.get(path)?.()
        restored = ctx.req.header('if-none-match')
      })

    ;(validated ? route.schema({ headers: $t.Object({ 'x-other': $t.String() }) }) : route).handler(ctx => ({
      inm: ctx.req.header('if-none-match') ?? null,
      has: ctx.req.hasHeader('if-modified-since'),
      all: Object.keys(ctx.req.header()),
    }))
  }

  // A schema that requires a validator validates what the client sent: hiding it from the handler is no reason to
  // refuse the request.
  validators
    .get('/required')
    .hook('onRequest', ctx => void withholdValidators(ctx))
    .schema({ headers: $t.Object({ 'if-none-match': $t.String() }) })
    .handler(() => 'ok')

  const served = createWebApplication()
    .logger(b => b.use(newNoopLogger()))
    .mount(validators)
  const sentHeaders = {
    'if-none-match': '"a"',
    'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT',
    'x-other': '1',
  }

  beforeAll(async () => {
    await served.bootstrap()
  })

  afterAll(async () => {
    await served.close()
  })

  async function seen(path: string): Promise<{ inm: string | null; has: boolean; all: string[] }> {
    restored = undefined
    return (await (await served.request(`/w${path}`, { headers: sentHeaders })).json()) as {
      inm: string | null
      has: boolean
      all: string[]
    }
  }

  it('hides both validators from what the handler reads of the request', async () => {
    const read = await seen('/plain')

    expect(read.inm).toBe(null)
    expect(read.has).toBe(false)
    expect(read.all).not.toContain('if-none-match')
    expect(read.all).not.toContain('if-modified-since')
  })

  it('leaves every other header alone', async () => {
    expect((await seen('/plain')).all).toContain('x-other')
  })

  it('puts them back for what runs after the handler', async () => {
    await seen('/plain')

    expect(restored).toBe('"a"')
  })

  // Validation runs after `onRequest` and keeps its own record of the headers, which must not lose them for good.
  it('puts them back on a route that validates its headers', async () => {
    const read = await seen('/validated')

    expect(read.inm).toBe(null)
    expect(restored).toBe('"a"')
  })

  it('validates the headers the client sent, the withheld ones included', async () => {
    const res = await served.request('/w/required', { headers: sentHeaders })

    expect(res.status).toBe(200)
  })

  it('refuses a context the engine did not build', () => {
    expect(() => withholdValidators({} as IContext)).toThrow(ErrConfiguration)
  })
})
