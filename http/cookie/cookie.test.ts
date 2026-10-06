import { CaffeineIoC, token } from '@caffeinejs/di'
import { newConfiguration } from '@caffeinejs/std'
import { InlineConfigSource } from '@caffeinejs/std/config/inline'
import { $t } from '@caffeinejs/std/schema'
import FastifyCookie, { sign, unsign } from '@fastify/cookie'
import { type FastifyInstance, type FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import { afterEach, describe, expect, it } from 'vitest'

import {
  $p,
  Args,
  bindTo,
  Catch,
  Controller,
  CookieSigner,
  createWebApplication,
  FastifyContext,
  Get,
  HMACCookieSigner,
  newRouter,
  Ops,
  type Context,
  type CookieUnsignResult,
} from '../index.js'

const SECRET = 'a-cookie-secret-of-at-least-32-characters'
const OLDER = 'an-older-cookie-secret-of-32-characters-or-more'
const TENANT = 'a-tenant-secret-handed-to-a-single-call'

const schema = $t.Object({
  app: $t.Object({
    cookie: $t.Object({
      enabled: $t.Optional($t.Boolean()),
      secret: $t.Optional($t.Union([$t.String(), $t.Array($t.String())])),
    }),
  }),
})

interface LogEntry {
  msg?: string
  err?: { message?: string; type?: string }
}

/** Fastify's own logger, writing every line into `logged`. Named in the factory settings, so it is the server's. */
function pinoTo(logged: LogEntry[], level = 'warn') {
  return { level, stream: { write: (line: string) => void logged.push(JSON.parse(line) as LogEntry) } }
}

function loggedError(logged: LogEntry[], text: string): boolean {
  return logged.some(entry => entry.err?.message?.includes(text) || entry.msg?.includes(text))
}

/** The value of the `name` cookie a response set, as the client would send it back. */
function cookieValue(response: Response, name: string): string | undefined {
  const line = response.headers.getSetCookie().find(set => set.startsWith(`${name}=`))
  return line?.slice(name.length + 1, line.indexOf(';') < 0 ? undefined : line.indexOf(';'))
}

let close: (() => Promise<unknown>) | undefined

afterEach(async () => {
  await close?.()
  close = undefined
})

// Mounting a router re-types the application with its routes, so what is kept is the way to close it.
async function ready<A extends { bootstrap(): Promise<unknown>; close(): Promise<unknown> }>(app: A): Promise<A> {
  close = () => app.close()
  await app.bootstrap()

  return app
}

const page = () => newRouter('/page').get('/', ctx => ({ session: ctx.req.cookie('session') ?? null }))

const signing = (options?: Parameters<Context['cookie']>[2]) =>
  newRouter('/sign').get('/', ctx => {
    ctx.cookie('tok', 'value', { signed: true, ...options })
    return { ok: true }
  })

const reading = (secret?: string | string[]) =>
  newRouter('/read').get('/', async ctx => ({ tok: (await ctx.req.signedCookie('tok', secret)) ?? null }))

/**
 * Reading cookies off the context. The cookie feature installs ahead of every plugin and parses on first read, so an
 * application neither registers anything nor has an order to get right.
 */
describe('ctx.req.cookie()', () => {
  it('reads a cookie with nothing registered by the application', async () => {
    const app = await ready(createWebApplication().mount(page()))

    const response = await app.fetch('/page', { headers: { cookie: 'session=abc' } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ session: 'abc' })
  })

  it('answers null for a cookie the request did not send', async () => {
    const app = await ready(createWebApplication().mount(page()))

    expect(await (await app.fetch('/page')).json()).toEqual({ session: null })
  })

  // Where an authentication scheme reads one: an `onRequest` hook of a plugin installed after the cookies.
  it('has them by the time an onRequest hook reads them', async () => {
    let early: string | undefined
    const readsEarly = () =>
      fp(
        async (instance: FastifyInstance) => {
          instance.addHook('onRequest', async request => {
            early = request.httpContext.req.cookie('session')
          })
        },
        { name: 'reads-cookie-early' },
      )

    const app = await ready(createWebApplication().with(readsEarly).mount(page()))

    await app.fetch('/page', { headers: { cookie: 'session=abc' } })

    expect(early).toBe('abc')
  })

  it("parses a request's cookies once, with the decoder parseOptions name", async () => {
    let decoded = 0
    const routes = newRouter('/both').get('/', ctx => ({ a: ctx.req.cookie('a'), all: ctx.req.cookie() }))

    const app = await ready(
      createWebApplication()
        .cookie(k => k.parseOptions({ decode: value => (decoded++, value.toUpperCase()) }))
        .mount(routes),
    )

    const response = await app.fetch('/both', { headers: { cookie: 'a=x; b=y' } })

    expect(await response.json()).toEqual({ a: 'X', all: { a: 'X', b: 'Y' } })
    expect(decoded).toBe(2)
  })
})

describe('signed cookies', () => {
  it('verifies a signed cookie with the secret the application stated', async () => {
    const app = await ready(
      createWebApplication()
        .cookie(k => k.secret(SECRET))
        .mount(signing(), reading()),
    )

    const tok = cookieValue(await app.fetch('/sign'), 'tok')!

    expect(await (await app.fetch('/read', { headers: { cookie: `tok=${tok}` } })).json()).toEqual({ tok: 'value' })
  })

  // A cookie issued before the move away from @fastify/cookie must still verify after it.
  it('signs as @fastify/cookie did', async () => {
    const app = await ready(
      createWebApplication()
        .cookie(k => k.secret(SECRET))
        .mount(signing()),
    )

    expect(cookieValue(await app.fetch('/sign'), 'tok')).toBe(sign('value', SECRET))
  })

  // The secret belongs in the environment, so the point of the config node is that it reaches the signer.
  it('signs with the secret the configuration carries', async () => {
    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ app: { cookie: { secret: SECRET } } }))
      .build().config

    const app = await ready(
      createWebApplication({ config: conf })
        .cookie((k, { config }) => k.config(config.app.cookie))
        .mount(reading()),
    )

    const response = await app.fetch('/read', { headers: { cookie: `tok=${sign('value', SECRET)}` } })

    expect(await response.json()).toEqual({ tok: 'value' })
  })

  // A fluent method is the last word: a secret written in code is not a default the tree outranks.
  it('prefers a secret set fluently over the one the configuration carries', async () => {
    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ app: { cookie: { secret: OLDER } } }))
      .build().config

    const app = await ready(
      createWebApplication({ config: conf })
        .cookie((k, { config }) => k.config(config.app.cookie).secret(SECRET))
        .mount(reading()),
    )

    const read = async (signed: string) => (await app.fetch('/read', { headers: { cookie: `tok=${signed}` } })).json()

    expect(await read(sign('value', SECRET))).toEqual({ tok: 'value' })
    expect(await read(sign('value', OLDER))).toEqual({ tok: false })
  })

  // Rotation from the environment: the newest secret first, the one being retired after it.
  it('rotates the secrets the configuration lists: the first signs, and any verifies', async () => {
    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ app: { cookie: { secret: [SECRET, OLDER] } } }))
      .build().config

    const app = await ready(
      createWebApplication({ config: conf })
        .cookie((k, { config }) => k.config(config.app.cookie))
        .mount(signing(), reading()),
    )

    expect(await (await app.fetch('/read', { headers: { cookie: `tok=${sign('value', OLDER)}` } })).json()).toEqual({
      tok: 'value',
    })
    expect(unsign(cookieValue(await app.fetch('/sign'), 'tok')!, SECRET)).toMatchObject({ valid: true, value: 'value' })
  })

  it('signs with the algorithm chosen', async () => {
    const app = await ready(
      createWebApplication()
        .cookie(k => k.secret(SECRET).algorithm('SHA-512'))
        .mount(signing()),
    )

    expect(cookieValue(await app.fetch('/sign'), 'tok')).toBe(sign('value', SECRET, 'sha512'))
  })

  // The escape hatch: a secret of the call's own — a tenant's — in place of the server's.
  it('signs and verifies with a secret the call hands over', async () => {
    const app = await ready(
      createWebApplication()
        .cookie(k => k.secret(SECRET))
        .mount(signing({ secret: TENANT }), reading(TENANT)),
    )

    const tok = cookieValue(await app.fetch('/sign'), 'tok')!

    expect(tok).toBe(sign('value', TENANT))
    expect(await (await app.fetch('/read', { headers: { cookie: `tok=${tok}` } })).json()).toEqual({ tok: 'value' })
  })

  it('refuses a signed cookie with nothing to sign it with, where it is set', async () => {
    const logged: LogEntry[] = []
    const app = await ready(
      createWebApplication()
        .server(() => ({ factory: { logger: pinoTo(logged, 'error') } }))
        .mount(signing()),
    )

    const response = await app.fetch('/sign')

    expect(response.status).toBe(500)
    expect(response.headers.getSetCookie()).toEqual([])
    expect(loggedError(logged, 'Cannot set cookie "tok" signed: no secret is configured')).toBe(true)
  })
})

/** Signs by reversing the value, so a test can tell its signatures from any HMAC. */
class ReversingSigner extends CookieSigner {
  async sign(value: string): Promise<string> {
    return `${value.split('').reverse().join('')}~`
  }

  async unsign(signed: string): Promise<CookieUnsignResult> {
    return signed.endsWith('~')
      ? { valid: true, renew: false, value: signed.slice(0, -1).split('').reverse().join('') }
      : { valid: false, renew: false, value: null }
  }
}

describe('a signer of the application', () => {
  it('signs with the instance handed over', async () => {
    const app = await ready(
      createWebApplication()
        .cookie(k => k.signer(new ReversingSigner()))
        .mount(signing(), reading()),
    )

    expect(cookieValue(await app.fetch('/sign'), 'tok')).toBe('eulav~')
    expect(await (await app.fetch('/read', { headers: { cookie: 'tok=eulav~' } })).json()).toEqual({ tok: 'value' })
  })

  // Resolved as the server starts, once: nothing on a request's path builds or looks up a signer.
  it('resolves a container key once, as the server starts', async () => {
    let built = 0
    const container = new CaffeineIoC()
    container.bind(CookieSigner, t => t.toFactory(() => (built++, new ReversingSigner())))

    const app = await ready(
      createWebApplication({ container })
        .cookie(k => k.signer(CookieSigner))
        .mount(signing(), reading()),
    )

    for (let i = 0; i < 3; i++) {
      expect(cookieValue(await app.fetch('/sign'), 'tok')).toBe('eulav~')
    }
    expect(built).toBe(1)
  })

  it('refuses to start when the key resolves to nothing', async () => {
    const app = createWebApplication().cookie(k => k.signer(token<CookieSigner>(Symbol('unbound.signer'))))
    close = () => app.close()

    await expect(app.bootstrap()).rejects.toMatchObject({
      name: 'ErrCookieConfiguration',
      message: expect.stringContaining('no binding registered for the given signer key'),
    })
  })

  it('refuses to start with a secret set too', async () => {
    const app = createWebApplication().cookie(k => k.secret(SECRET).signer(new ReversingSigner()))
    close = () => app.close()

    await expect(app.bootstrap()).rejects.toMatchObject({
      name: 'ErrCookieConfiguration',
      message: expect.stringContaining('both a signer and a secret are configured'),
    })
  })

  // Code is the last word over the environment, so a signer written there sets the tree's secret aside.
  it('outranks the secret the configuration carries', async () => {
    const conf = newConfiguration(schema)
      .source(new InlineConfigSource({ app: { cookie: { secret: SECRET } } }))
      .build().config

    const app = await ready(
      createWebApplication({ config: conf })
        .cookie((k, { config }) => k.config(config.app.cookie).signer(new ReversingSigner()))
        .mount(signing()),
    )

    expect(cookieValue(await app.fetch('/sign'), 'tok')).toBe('eulav~')
  })
})

describe('writing cookies', () => {
  // What every cookie the application sets starts from, so a route states only where it differs.
  it('starts every cookie a route sets from the parse options', async () => {
    const setting = newRouter('/set').get('/', ctx => {
      ctx.cookie('session', 'value')
      return { ok: true }
    })

    const app = await ready(
      createWebApplication()
        .cookie(k => k.parseOptions({ path: '/scoped', httpOnly: true }))
        .mount(setting),
    )

    expect((await app.fetch('/set')).headers.getSetCookie()).toEqual([
      'session=value; Path=/scoped; HttpOnly; SameSite=Lax',
    ])
  })

  // The cookie schemes clear a session and write a fresh one in the same response; the browser must see the last.
  it('writes one cookie per name, domain and path, the last one set', async () => {
    const routes = newRouter('/again').get('/', ctx => {
      ctx.deleteCookie('session')
      ctx.cookie('session', 'fresh')
      return { ok: true }
    })

    const app = await ready(createWebApplication().mount(routes))

    expect((await app.fetch('/again')).headers.getSetCookie()).toEqual(['session=fresh; Path=/; SameSite=Lax'])
  })

  // Merged, never replaced: what the route put there itself goes out too, once.
  it('adds its cookies to the Set-Cookie values already on the response', async () => {
    const routes = newRouter('/merge')
      .get('/appended', ctx => {
        ctx.appendHeader('set-cookie', 'first=1')
        ctx.appendHeader('set-cookie', 'second=2')
        ctx.cookie('third', '3')
        return { ok: true }
      })
      .get('/raw', ctx => {
        ctx.platform.reply.raw.setHeader('set-cookie', 'raw=1')
        ctx.cookie('ours', '2')
        return { ok: true }
      })

    const app = await ready(createWebApplication().mount(routes))

    expect((await app.fetch('/merge/appended')).headers.getSetCookie()).toEqual([
      'first=1',
      'second=2',
      'third=3; Path=/; SameSite=Lax',
    ])
    expect((await app.fetch('/merge/raw')).headers.getSetCookie()).toEqual(['raw=1', 'ours=2; Path=/; SameSite=Lax'])
  })

  it('writes the cookies of a HEAD request', async () => {
    const routes = newRouter('/head').get('/', ctx => {
      ctx.cookie('seen', 'yes')
      return { ok: true }
    })

    const app = await ready(createWebApplication().mount(routes))

    expect((await app.fetch('/head', { method: 'HEAD' })).headers.getSetCookie()).toEqual([
      'seen=yes; Path=/; SameSite=Lax',
    ])
  })

  it("sets Secure for a request a trusted proxy says came over HTTPS, with secure: 'auto'", async () => {
    const routes = newRouter('/auto').get('/', ctx => {
      ctx.cookie('id', 'v', { secure: 'auto' })
      return { ok: true }
    })

    const app = await ready(
      createWebApplication()
        .server(() => ({ factory: { trustProxy: true } }))
        .mount(routes),
    )

    expect((await app.fetch('/auto', { headers: { 'x-forwarded-proto': 'https' } })).headers.getSetCookie()).toEqual([
      'id=v; Path=/; Secure; SameSite=Lax',
    ])
    expect((await app.fetch('/auto')).headers.getSetCookie()).toEqual(['id=v; Path=/; SameSite=Lax'])
  })

  // Dropped by the browser without a word otherwise, which looks like a sign-in that never sticks.
  it('refuses a cookie a browser would drop, where it is set', async () => {
    const logged: LogEntry[] = []
    const routes = newRouter('/host').get('/', ctx => {
      ctx.cookie('__Host-id', 'v')
      return { ok: true }
    })

    const app = await ready(
      createWebApplication()
        .server(() => ({ factory: { logger: pinoTo(logged, 'error') } }))
        .mount(routes),
    )

    expect((await app.fetch('/host')).status).toBe(500)
    expect(loggedError(logged, 'a "__Host-" cookie needs Secure, Path=/ and no Domain')).toBe(true)
  })
})

describe('cookies set late', () => {
  /** A plugin whose `onSend` hook, installed after the cookies, sets one on the response it sees first. */
  function settingOnSend(options?: { signed?: boolean }) {
    const seen = new WeakSet<FastifyRequest>()

    return () =>
      fp(
        async (instance: FastifyInstance) => {
          instance.addHook('onSend', async request => {
            if (!seen.has(request)) {
              seen.add(request)
              request.httpContext.cookie('late', 'v', options)
            }
          })
        },
        { name: 'sets-cookie-on-send' },
      )
  }

  const answer = () => newRouter('/answer').get('/', () => ({ ok: true }))

  it('writes an unsigned cookie a later onSend hook sets', async () => {
    const app = await ready(createWebApplication().with(settingOnSend()).mount(answer()))

    expect((await app.fetch('/answer')).headers.getSetCookie()).toEqual(['late=v; Path=/; SameSite=Lax'])
  })

  // Signing takes a turn of the event loop the headers do not wait for once the cookies were written.
  it('refuses a signed one', async () => {
    const logged: LogEntry[] = []
    const app = await ready(
      createWebApplication()
        .cookie(k => k.secret(SECRET))
        .server(() => ({ factory: { logger: pinoTo(logged, 'error') } }))
        .with(settingOnSend({ signed: true }))
        .mount(answer()),
    )

    expect((await app.fetch('/answer')).status).toBe(500)
    expect(loggedError(logged, 'Cannot set cookie "late" signed: the response\'s cookies are already written')).toBe(
      true,
    )
  })

  it('refuses one once the response is out', async () => {
    const refused: unknown[] = []
    const onResponse = () =>
      fp(
        async (instance: FastifyInstance) => {
          instance.addHook('onResponse', async request => {
            try {
              request.httpContext.cookie('gone', 'v')
            } catch (err) {
              refused.push(err)
            }
          })
        },
        { name: 'sets-cookie-on-response' },
      )

    const app = await ready(createWebApplication().with(onResponse).mount(answer()))

    await app.fetch('/answer')

    expect(refused).toEqual([expect.objectContaining({ name: 'ErrCookieTooLate' })])
  })
})

/** A signer that cannot sign: a remote key service that is down. */
class FailingSigner extends CookieSigner {
  async sign(): Promise<string> {
    throw new Error('the key service is down')
  }

  async unsign(): Promise<CookieUnsignResult> {
    return { valid: false, renew: false, value: null }
  }
}

describe('a signer that fails', () => {
  it('answers 500 with none of the cookies it was signing alongside', async () => {
    const routes = newRouter('/batch').get('/', ctx => {
      ctx.cookie('plain', 'v')
      ctx.cookie('signed', 'v', { signed: true })
      return { ok: true }
    })

    const app = await ready(
      createWebApplication()
        .cookie(k => k.signer(new FailingSigner()))
        .mount(routes),
    )

    const response = await app.fetch('/batch')

    expect(response.status).toBe(500)
    expect(response.headers.getSetCookie()).toEqual([])
  })

  // The send the handler made died in the cookie writer, so nothing is in flight for the error handler to wait on.
  // Waiting would hold the request open until the socket timed out.
  it('leaves the request to a @Catch handler, which answers it once', async () => {
    @Controller('/cookie-signer-fails')
    class SignInController {
      @Get('/value')
      @Args([$p.context()])
      value(ctx: Context) {
        ctx.cookie('session', 'v', { signed: true })
        ctx.redirect('/home')
      }

      @Get('/context')
      @Args([$p.context()])
      context(ctx: Context) {
        ctx.cookie('session', 'v', { signed: true })
        ctx.redirect('/home')
      }

      @Catch(Error)
      caught(ctx: Context) {
        if (ctx.req.url.endsWith('/context')) {
          ctx.status(503).body({ caught: 'context' })
          return
        }

        ctx.status(503)
        return { caught: 'value' }
      }
    }
    void [SignInController]

    const app = await ready(createWebApplication().cookie(k => k.signer(new FailingSigner())))

    const byValue = await app.fetch('/cookie-signer-fails/value')
    expect(byValue.status).toBe(503)
    expect(await byValue.json()).toEqual({ caught: 'value' })

    const byContext = await app.fetch('/cookie-signer-fails/context')
    expect(byContext.status).toBe(503)
    expect(await byContext.json()).toEqual({ caught: 'context' })
  })
})

describe('servers', () => {
  const listener = { host: '127.0.0.1', port: 0 }

  it('serves cookies on an ops server, with the same settings', async () => {
    const admin = newRouter('/admin')
      .with(bindTo('admin'))
      .get('/sign', ctx => {
        ctx.cookie('tok', 'value', { signed: true })
        return { ok: true }
      })
      .get('/read', async ctx => ({ tok: await ctx.req.signedCookie('tok') }))

    const app = createWebApplication()
      .install(Ops('admin', o => o.server(() => ({ listener }))))
      .server(() => ({ listener }))
      .cookie(k => k.secret(SECRET))
      .mount(admin)
    close = () => app.close()

    await app.run()
    const origin = app.ops.get('admin')!.address!.origin

    const tok = cookieValue(await fetch(`${origin}/admin/sign`), 'tok')!
    expect(tok).toBe(sign('value', SECRET))

    const read = await fetch(`${origin}/admin/read`, { headers: { cookie: `tok=${tok}` } })
    expect(await read.json()).toEqual({ tok: 'value' })
  })

  // Its context was created before the cookie plugin registered, so its responses run none of the writer's hooks:
  // a cookie set there would never go out.
  it('refuses a cookie on a route of a plugin registered in .serverCallback()', async () => {
    const logged: LogEntry[] = []
    const app = await ready(
      createWebApplication()
        .server(() => ({ factory: { logger: pinoTo(logged, 'error') } }))
        .serverCallback((_context, server) => {
          server.register(async child => {
            child.get('/early', async request => {
              request.httpContext.cookie('a', 'b')
              return { ok: true }
            })
          })
        }),
    )

    expect((await app.fetch('/early')).status).toBe(500)
    expect(loggedError(logged, 'this route was registered before the cookie plugin')).toBe(true)
  })
})

// An ecosystem plugin that needs @fastify/cookie — csrf-protection, say — has the application register it; the
// context's cookies stay this feature's either way.
describe('alongside @fastify/cookie', () => {
  const both = () =>
    newRouter('/both').get('/', async ctx => {
      ctx.platform.reply.setCookie('theirs', 'x')
      ctx.cookie('ours', 'y')
      return { tok: (await ctx.req.signedCookie('tok')) ?? null }
    })

  const registrations = {
    '.serverCallback(...)': createWebApplication().serverCallback((_context, server) => {
      server.register(FastifyCookie, { secret: OLDER })
    }),
    '.with(...)': createWebApplication().with(() => [FastifyCookie, { secret: OLDER }]),
  }

  for (const [where, application] of Object.entries(registrations)) {
    it(`writes both plugins' cookies, registered through ${where}`, async () => {
      const app = await ready(application.cookie(k => k.secret(SECRET)).mount(both()))

      const ours = await app.fetch('/both', { headers: { cookie: `tok=${sign('value', SECRET)}` } })
      const lines = ours.headers.getSetCookie()

      expect(lines).toContain('ours=y; Path=/; SameSite=Lax')
      expect(lines.some(line => line.startsWith('theirs=x'))).toBe(true)
      expect(await ours.json()).toEqual({ tok: 'value' })

      const theirs = await app.fetch('/both', { headers: { cookie: `tok=${sign('value', OLDER)}` } })
      expect(await theirs.json()).toEqual({ tok: false })
    })
  }
})

// Off means no plugin, so a read fails where it is made instead of answering undefined and letting a cookie scheme
// authenticate nobody. The diagnostic is written for whoever runs the application, so it goes to the log and the
// caller is told only that the request failed.
describe('cookies turned off', () => {
  it('fails the read', async () => {
    const logged: LogEntry[] = []
    const app = await ready(
      createWebApplication()
        .cookie(k => k.enabled(false))
        .server(() => ({ factory: { logger: pinoTo(logged, 'error') } }))
        .mount(page()),
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
    expect(text).not.toContain('disabled')

    expect(loggedError(logged, 'Cannot read cookies: cookies are disabled on this server')).toBe(true)
  })
})

describe('the cookie pickers', () => {
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

    const app = await ready(createWebApplication())

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

    const app = await ready(createWebApplication())

    const res = await app.fetch('/ck/all', { headers: { Cookie: 'a=1; b=2' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ a: '1', b: '2' })
  })

  it('injects a signed cookie via signedCookie() picker', async () => {
    @Controller('/ck')
    class SignedController {
      @Get('/signed')
      @Args([$p.signedCookie('tok')])
      get(tok: string | false | undefined) {
        return { tok }
      }
    }
    void [SignedController]

    const app = await ready(createWebApplication().cookie(k => k.secret(SECRET)))

    const res = await app.fetch('/ck/signed', { headers: { Cookie: `tok=${sign('myvalue', SECRET)}` } })
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

    const app = await ready(createWebApplication().cookie(k => k.secret(SECRET)))

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

    const app = await ready(createWebApplication())

    const res = await app.fetch('/ck/set')
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBe('session=hello; Path=/; HttpOnly; SameSite=Lax')
  })

  it('ctx.req.signedCookie() reads a signed cookie from the request', async () => {
    @Controller('/ck')
    class ReqSignedCookieController {
      @Get('/read')
      @Args([$p.context()])
      async read(ctx: FastifyContext) {
        return { value: await ctx.req.signedCookie('tok') }
      }
    }
    void [ReqSignedCookieController]

    const app = await ready(createWebApplication().cookie(k => k.secret(SECRET)))

    const res = await app.fetch('/ck/read', { headers: { Cookie: `tok=${sign('reqvalue', SECRET)}` } })
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

    const app = await ready(createWebApplication())

    const res = await app.fetch('/ck/delete')
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBe(
      'session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax',
    )
  })
})
