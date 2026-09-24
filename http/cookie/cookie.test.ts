import { token } from '@caffeinejs/di'
import { $t, newConfiguration } from '@caffeinejs/std'
import { InlineConfigSource, type InferConfig } from '@caffeinejs/std/config'
import FastifyCookie, { sign } from '@fastify/cookie'
import { type FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import {
  $p,
  Args,
  Controller,
  cookieConfigSchema,
  createWebApplication,
  FastifyContext,
  Get,
  newRouter,
} from '../index.js'

const schema = $t.Object({ app: $t.Object({ cookie: cookieConfigSchema }) })

const kConfig = token<InferConfig<typeof schema>>(Symbol('cookie.app.config'))

interface LogEntry {
  msg?: string
}

/** Fastify's own logger, writing every line into `logged`. Named in the factory settings, so it is the server's. */
function pinoTo(logged: LogEntry[], level = 'warn') {
  return { level, stream: { write: (line: string) => void logged.push(JSON.parse(line) as LogEntry) } }
}

/**
 * Reading cookies off the context. The cookie feature registers `@fastify/cookie` ahead of every plugin, so an
 * application neither registers it nor has an order to get right — which used to be its job, and used to surface
 * as a bare TypeError when it got it wrong.
 */
describe('ctx.req.cookie()', () => {
  let close: (() => Promise<unknown>) | undefined

  afterEach(async () => {
    await close?.()
    close = undefined
  })

  // Mounting a router re-types the application with its routes, so what is kept is the way to close it.
  async function ready<A extends { ready(): Promise<unknown>; close(): Promise<unknown> }>(app: A): Promise<A> {
    close = () => app.close()
    await app.ready()

    return app
  }

  /** Reads a cookie from an `onRequest` hook, which is where an authentication scheme reads one. */
  function readsCookieEarly() {
    return () =>
      fp(
        async (instance: FastifyInstance) => {
          instance.addHook('onRequest', async request => {
            request.httpContext.req.cookie('session')
          })
        },
        { name: 'reads-cookie-early' },
      )
  }

  const routes = () => newRouter('/page').get('/', ctx => ({ session: ctx.req.cookie('session') ?? null }))

  const reads = () => newRouter('/read').get('/', ctx => ({ tok: ctx.req.signedCookie('tok') }))

  it('reads a cookie with nothing registered by the application', async () => {
    const app = await ready(createWebApplication().mount(routes()))

    const response = await app.fetch('/page', { headers: { cookie: 'session=abc' } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ session: 'abc' })
  })

  it('answers null for a cookie the request did not send', async () => {
    const app = await ready(createWebApplication().mount(routes()))

    expect(await (await app.fetch('/page')).json()).toEqual({ session: null })
  })

  // The parsing is in place before any plugin registers, so a hook that runs ahead of the routes sees it too.
  it('has them parsed by the time an onRequest hook reads them', async () => {
    const app = await ready(createWebApplication().with(readsCookieEarly()).mount(routes()))

    const response = await app.fetch('/page', { headers: { cookie: 'session=abc' } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ session: 'abc' })
  })

  it('verifies a signed cookie with the secret the application stated', async () => {
    const secret = 'a-cookie-secret-of-at-least-32-characters'

    const signing = newRouter('/signed').get('/', ctx => {
      ctx.cookie('tok', 'value', { signed: true })

      return { ok: true }
    })

    const app = await ready(
      createWebApplication()
        .cookie(k => k.secret(secret))
        .mount(signing, reads()),
    )

    const issued = (await app.fetch('/signed')).headers.getSetCookie()[0]
    const tok = issued.slice('tok='.length, issued.indexOf(';'))

    expect(await (await app.fetch('/read', { headers: { cookie: `tok=${tok}` } })).json()).toEqual({ tok: 'value' })
  })

  // The secret belongs in the environment, so the point of the config node is that it reaches the plugin.
  it('signs with the secret the configuration carries', async () => {
    const secret = 'a-secret-that-came-from-the-configuration'

    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ app: { cookie: { secret } } }))
      .build()

    const app = await ready(
      createWebApplication({ config: conf })
        .cookie((k, { config }) => k.config(config.app.cookie))
        .mount(reads()),
    )

    const response = await app.fetch('/read', { headers: { cookie: `tok=${sign('value', secret)}` } })

    expect(await response.json()).toEqual({ tok: 'value' })
  })

  // A fluent method is the last word: a secret written in code is not a default the tree outranks.
  it('prefers a secret set fluently over the one the configuration carries', async () => {
    const fromConfig = 'a-secret-that-came-from-the-configuration'
    const fromCode = 'a-secret-that-was-written-in-the-code'

    const conf = newConfiguration(schema, kConfig)
      .source(new InlineConfigSource({ app: { cookie: { secret: fromConfig } } }))
      .build()

    const app = await ready(
      createWebApplication({ config: conf })
        .cookie((k, { config }) => k.config(config.app.cookie).secret(fromCode))
        .mount(reads()),
    )

    expect(await (await app.fetch('/read', { headers: { cookie: `tok=${sign('value', fromCode)}` } })).json()).toEqual({
      tok: 'value',
    })
    expect(
      await (await app.fetch('/read', { headers: { cookie: `tok=${sign('value', fromConfig)}` } })).json(),
    ).toEqual({ tok: false })
  })

  // The application owns the registration, secret included, so the feature stands down rather than failing the
  // start-up on decorators that are already there.
  it('leaves a server that registered the plugin itself alone', async () => {
    const secret = 'the-secret-the-application-registered-with'

    const app = await ready(
      createWebApplication()
        .serverCallback((_context, server) => {
          server.register(FastifyCookie, { secret })
        })
        .mount(reads()),
    )

    const response = await app.fetch('/read', { headers: { cookie: `tok=${sign('value', secret)}` } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ tok: 'value' })
  })

  // Off means unregistered, so a read fails where it is made instead of answering undefined and letting a
  // cookie scheme authenticate nobody. The diagnostic naming the plugin is written for whoever runs the
  // application, so it goes to the log and the caller is told only that the request failed.
  it('fails the read when the application turned cookies off', async () => {
    const logged: LogEntry[] = []
    const app = await ready(
      createWebApplication()
        .cookie(k => k.enabled(false))
        .server(() => ({ factory: { logger: pinoTo(logged, 'error') } }))
        .mount(routes()),
    )

    const response = await app.fetch('/page', { headers: { cookie: 'session=abc' } })
    const text = await response.text()

    expect(response.status).toBe(500)
    expect(JSON.parse(text)).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      code: 'ERR_INTERNAL',
      message: 'Internal Server Error',
    })
    expect(text).not.toContain('@fastify/cookie')

    expect(logged.some(entry => entry.msg?.includes('@fastify/cookie plugin is not registered'))).toBe(true)
  })
})

// The cookie feature registers @fastify/cookie, so an application that signs cookies states the secret with
// .cookie(...) rather than registering the plugin a second time — which Fastify refuses, the decorators
// being there.
describe('Cookies', () => {
  it('injects a named cookie via cookie() picker', async () => {
    @Controller('/ck')
    class NamedCookieController {
      @Get('/session')
      @Args([$p.cookie('session')])
      get(session: string | undefined) {
        return { session }
      }
    }
    void [NamedCookieController]

    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/ck/session', { headers: { Cookie: 'session=abc123' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ session: 'abc123' })
  })

  it('injects all cookies via cookie() picker without a name', async () => {
    @Controller('/ck')
    class AllCookiesController {
      @Get('/all')
      @Args([$p.cookie()])
      get(cookies: Record<string, string | undefined>) {
        return cookies
      }
    }
    void [AllCookiesController]

    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/ck/all', { headers: { Cookie: 'a=1; b=2' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ a: '1', b: '2' })
  })

  it('injects a signed cookie via signedCookie() picker', async () => {
    const SECRET = 'test-secret'
    const signed = sign('myvalue', SECRET)

    @Controller('/ck')
    class SignedController {
      @Get('/signed')
      @Args([$p.signedCookie('tok')])
      get(tok: string | false | undefined) {
        return { tok }
      }
    }
    void [SignedController]

    const app = createWebApplication().cookie(k => k.secret(SECRET))
    await app.ready()

    const res = await app.fetch('/ck/signed', { headers: { Cookie: `tok=${signed}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tok: 'myvalue' })
  })

  it('returns false for a tampered signed cookie via signedCookie() picker', async () => {
    @Controller('/ck')
    class TamperedController {
      @Get('/tampered')
      @Args([$p.signedCookie('tok')])
      get(tok: string | false | undefined) {
        return { valid: tok !== false }
      }
    }
    void [TamperedController]

    const app = createWebApplication().cookie(k => k.secret('test-secret'))
    await app.ready()

    const res = await app.fetch('/ck/tampered', { headers: { Cookie: 'tok=badvalue.invalidsig' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ valid: false })
  })

  it('setCookie helper sets a Set-Cookie header on the response', async () => {
    @Controller('/ck')
    class SetCookieController {
      @Get('/set')
      @Args([$p.context()])
      get(ctx: FastifyContext) {
        ctx.cookie('session', 'hello', { httpOnly: true, path: '/' })
        return { ok: true }
      }
    }
    void [SetCookieController]

    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/ck/set')
    expect(res.status).toBe(200)
    const setCookieHeader = res.headers.get('set-cookie')
    expect(setCookieHeader).toMatch(/session=hello/)
    expect(setCookieHeader).toMatch(/HttpOnly/)
  })

  it('getCookie helper reads a cookie from the request via context', async () => {
    @Controller('/ck')
    class GetCookieController {
      @Get('/get')
      @Args([$p.context()])
      get(ctx: FastifyContext) {
        return { value: ctx.req.cookie('token') }
      }
    }
    void [GetCookieController]

    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/ck/get', { headers: { Cookie: 'token=secret' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ value: 'secret' })
  })

  it('ctx.req.signedCookie() reads a signed cookie from the request', async () => {
    const SECRET = 'req-signed-secret'
    const signed = sign('reqvalue', SECRET)

    @Controller('/ck')
    class ReqSignedCookieController {
      @Get('/read')
      @Args([$p.context()])
      read(ctx: FastifyContext) {
        return { value: ctx.req.signedCookie('tok') }
      }
    }
    void [ReqSignedCookieController]

    const app = createWebApplication().cookie(k => k.secret(SECRET))
    await app.ready()

    const res = await app.fetch('/ck/read', { headers: { Cookie: `tok=${signed}` } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ value: 'reqvalue' })
  })

  it('deleteCookie helper clears a cookie', async () => {
    @Controller('/ck')
    class DeleteCookieController {
      @Get('/delete')
      @Args([$p.context()])
      get(ctx: FastifyContext) {
        ctx.deleteCookie('session')
        return { ok: true }
      }
    }
    void [DeleteCookieController]

    const app = createWebApplication()
    await app.ready()

    const res = await app.fetch('/ck/delete')
    expect(res.status).toBe(200)
    const setCookieHeader = res.headers.get('set-cookie')
    expect(setCookieHeader).toMatch(/session=/)
    expect(setCookieHeader).toMatch(/Max-Age=0/)
  })
})
