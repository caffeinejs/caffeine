import { newNoopLogger } from '@caffeinejs/application/logger'
import { Millisecond, Minute, Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWebApplication } from '../../application.js'
import type { IContext } from '../../context.js'
import { bindTo } from '../../decorators/bind_to.js'
import { version } from '../../decorators/version.js'
import { createWebApplication as createNodeApplication } from '../../platform/node/node.js'
import { ErrConfiguration } from '../error/common.js'
import { findMyWayMatcher } from '../matcher/find_my_way.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { Authentication } from '../security/auth/auth.js'
import { BaseAuthenticationHandler } from '../security/auth/handler.js'
import { AuthenticateResult, AuthenticationTicket } from '../security/auth/ticket.js'
import { Claim, Identity, Principal } from '../security/identity.js'
import { authentication } from '../security/security.js'
import { cors, corsPolicy, kCORSRoute, type CORSBuilder } from './cors.js'

// Any router, as `mount` takes them: the route types each carries are not under test here.
type AnyRouter = Router<any, any, any, any, any, any>

const A = 'https://app.example'
const PARTNER = 'https://partner.example'

let app: { close(): Promise<void> } | undefined

afterEach(async () => {
  await app?.close().catch(() => undefined)
  app = undefined
})

/** Authenticates a request carrying its header; challenges with its own name. */
class HeaderScheme extends BaseAuthenticationHandler<object> {
  constructor(
    private readonly scheme: string,
    private readonly header: string,
  ) {
    super({})
  }

  async authenticate(ctx: IContext): Promise<AuthenticateResult> {
    const user = ctx.req.header(this.header)
    if (user === undefined) {
      return AuthenticateResult.none()
    }

    const principal = new Principal(true, [new Identity(this.scheme, true, [new Claim('sub', user, '')])])
    return AuthenticateResult.success(new AuthenticationTicket(principal, this.scheme))
  }

  override async challenge(ctx: IContext): Promise<void> {
    ctx.status(401).header('www-authenticate', this.scheme)
  }
}

const r = () =>
  new Router('/r')
    .get('/')
    .handler(() => 'r')
    .post('/')
    .handler(() => 'p')
const off = () =>
  new Router('/off')
    .extend(cors(false))
    .get('/')
    .handler(() => 'off')

/** The fetch application with `/r` and `/off`, under a policy allowing `A`, or the one `configure` writes. */
async function serve(configure: (c: CORSBuilder) => CORSBuilder = c => c.origins(A), ...routers: AnyRouter[]) {
  const built = createWebApplication()
    .with(corsPolicy(configure))
    .mount(r(), off(), ...routers)
  app = built
  await built.bootstrap()
  return built
}

/** An `OPTIONS` preflight from `origin` asking for `method`, with whatever other headers the case needs. */
function preflight(origin: string, method: string, headers: Record<string, string> = {}): RequestInit {
  return { method: 'OPTIONS', headers: { origin, 'access-control-request-method': method, ...headers } }
}

/** Every `access-control-*` header of `res`. */
function corsHeaders(res: Response): Record<string, string> {
  return Object.fromEntries([...res.headers].filter(([name]) => name.startsWith('access-control-')))
}

describe('corsPolicy() on an actual request', () => {
  it('allows a listed origin, and varies on Origin', async () => {
    const res = await (await serve()).request('/r', { headers: { origin: A } })

    expect(res.status).toBe(200)
    expect(corsHeaders(res)).toEqual({ 'access-control-allow-origin': A })
    expect(res.headers.get('vary')).toBe('Origin')
  })

  it('says nothing to an origin it does not list', async () => {
    const res = await (await serve()).request('/r', { headers: { origin: 'https://evil.example' } })

    expect(res.status).toBe(200)
    expect(corsHeaders(res)).toEqual({})
    expect(res.headers.get('vary')).toBe('Origin')
  })

  // A cache keyed on the URL alone would hand the answer to a request from an allowed origin.
  it('varies on Origin when the request sends none', async () => {
    const res = await (await serve()).request('/r')

    expect(corsHeaders(res)).toEqual({})
    expect(res.headers.get('vary')).toBe('Origin')
  })

  it('leaves a route marked cors(false) alone', async () => {
    const res = await (await serve()).request('/off', { headers: { origin: A } })

    expect(res.status).toBe(200)
    expect(corsHeaders(res)).toEqual({})
    expect(res.headers.get('vary')).toBe(null)
  })

  it("lets a route's cors(...) name origins of its own", async () => {
    const wide = new Router('/wide')
      .extend(cors({ origins: [PARTNER] }))
      .get('/')
      .handler(() => 'w')
    const built = await serve(undefined, wide)

    expect(corsHeaders(await built.request('/wide', { headers: { origin: PARTNER } }))).toEqual({
      'access-control-allow-origin': PARTNER,
    })
    expect(corsHeaders(await built.request('/wide', { headers: { origin: A } }))).toEqual({})
    expect(corsHeaders(await built.request('/wide', preflight(PARTNER, 'GET')))['access-control-allow-origin']).toBe(
      PARTNER,
    )
  })

  it('answers * to any origin under "*", and varies on nothing', async () => {
    const res = await (await serve(c => c.origins('*'))).request('/r', { headers: { origin: 'https://any.example' } })

    expect(corsHeaders(res)).toEqual({ 'access-control-allow-origin': '*' })
    expect(res.headers.get('vary')).toBe(null)
  })

  // The answer must not depend on Origin when it does not vary on it: a cache would hand one to the other.
  it('answers * under "*" to a request that sends no Origin too', async () => {
    const res = await (await serve(c => c.origins('*').exposedHeaders('x-total'))).request('/r')

    expect(corsHeaders(res)).toEqual({ 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-total' })
    expect(res.headers.get('vary')).toBe(null)
  })

  it('lets credentials through for a listed origin', async () => {
    const res = await (await serve(c => c.origins(A).credentials())).request('/r', { headers: { origin: A } })

    expect(corsHeaders(res)).toEqual({
      'access-control-allow-origin': A,
      'access-control-allow-credentials': 'true',
    })
  })

  it('exposes the headers it lists', async () => {
    const res = await (
      await serve(c => c.origins(A).exposedHeaders('x-total'))
    ).request('/r', {
      headers: { origin: A },
    })

    expect(res.headers.get('access-control-expose-headers')).toBe('x-total')
  })

  // A page reads why it was refused only when the refusal carries the header.
  it('answers a miss for a listed origin', async () => {
    const res = await (await serve()).request('/nope', { headers: { origin: A } })

    expect(res.status).toBe(404)
    expect(res.headers.get('access-control-allow-origin')).toBe(A)
  })

  it.each([
    ['authentication() first', true],
    ['corsPolicy() first', false],
  ])("answers the gate's refusal, with %s", async (_order, gateFirst) => {
    const gate = authentication()
    const policy = corsPolicy(c => c.origins(A))
    const built = createWebApplication()
      .install(Authentication(a => a.addStrategy('A', new HeaderScheme('A', 'x-a')).default('A')))
      .with(gateFirst ? gate : policy)
      .with(gateFirst ? policy : gate)
      .mount(
        new Router('/p')
          .authorize({ roles: [] })
          .get('/')
          .handler(() => 'ok'),
      )
    app = built
    await built.bootstrap()

    const res = await built.request('/p', { headers: { origin: A } })

    expect(res.status).toBe(401)
    expect(res.headers.get('access-control-allow-origin')).toBe(A)
  })

  it('answers on a listener its own policy, and leaves the application alone', async () => {
    const built = createWebApplication()
      .listener('admin', l => l.with(corsPolicy(c => c.origins(A))))
      .mount(
        new Router('/jobs')
          .extend(bindTo('admin'))
          .get('/')
          .handler(() => 'jobs'),
        new Router('/own').get('/').handler(() => 'own'),
      )
    app = built
    await built.bootstrap()

    const listener = await built.listeners
      .get('admin')!
      .fetch(new Request('http://localhost/jobs', { headers: { origin: A } }))
    const own = await built.fetch(new Request('http://localhost/own', { headers: { origin: A } }))

    expect(listener.headers.get('access-control-allow-origin')).toBe(A)
    expect(corsHeaders(own)).toEqual({})
  })
})

describe('corsPolicy() on a preflight', () => {
  it('grants the method a route serves, reflecting the headers asked for', async () => {
    const res = await (
      await serve()
    ).request('/r', preflight(A, 'POST', { 'access-control-request-headers': 'x-a, content-type' }))

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(corsHeaders(res)).toEqual({
      'access-control-allow-origin': A,
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'x-a, content-type',
    })
    expect(res.headers.get('vary')).toBe('Origin, Access-Control-Request-Headers')
  })

  it('allows the headers it lists, and says how long to keep the answer', async () => {
    const built = await serve(c =>
      c
        .origins(A)
        .allowedHeaders('x-a')
        .maxAge(10 * Minute),
    )

    const res = await built.request(
      '/r',
      preflight(A, 'POST', { 'access-control-request-headers': 'x-a, content-type' }),
    )

    expect(res.headers.get('access-control-allow-headers')).toBe('x-a')
    expect(res.headers.get('access-control-max-age')).toBe('600')
    expect(res.headers.get('vary')).toBe('Origin')
  })

  it('takes a maxAge set fluently over the one config(...) handed over', async () => {
    const built = await serve(c => c.config({ origins: [A], maxAge: 60 * Second }).maxAge(120 * Second))

    expect((await built.request('/r', preflight(A, 'GET'))).headers.get('access-control-max-age')).toBe('120')
  })

  it('grants GET on a path that serves it', async () => {
    const res = await (await serve()).request('/r', preflight(A, 'GET'))

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toBe('GET')
  })

  it('leaves a preflight for a method no route serves to the 404, with no CORS header', async () => {
    const res = await (await serve()).request('/r', preflight(A, 'DELETE'))

    expect(res.status).toBe(404)
    expect(corsHeaders(res)).toEqual({})
    // The problem answer's own: the policy adds nothing.
    expect(res.headers.get('vary')).toBe('Accept')
  })

  it('leaves a preflight from an origin it does not list to the 404, with no CORS header', async () => {
    const res = await (await serve()).request('/r', preflight('https://evil.example', 'POST'))

    expect(res.status).toBe(404)
    expect(corsHeaders(res)).toEqual({})
    // The problem answer's own: the policy adds nothing.
    expect(res.headers.get('vary')).toBe('Accept')
  })

  it('grants the preflight of a route marked cors(true) from the policy', async () => {
    const on = new Router('/on')
      .extend(cors(true))
      .get('/')
      .handler(() => 'on')
    const res = await (await serve(undefined, on)).request('/on', preflight(A, 'GET'))

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(A)
  })

  // A path that cannot be decoded names no route: the preflight goes on to the not-found answer.
  it('leaves a preflight for a path that cannot be decoded alone', async () => {
    const res = await (await serve()).request('/%E0%A4%A', preflight(A, 'GET'))

    expect(res.status).toBe(404)
    expect(corsHeaders(res)).toEqual({})
  })

  it('leaves the preflight of a route marked cors(false) to the 404', async () => {
    const res = await (await serve()).request('/off', preflight(A, 'GET'))

    expect(res.status).toBe(404)
    expect(corsHeaders(res)).toEqual({})
  })

  // A browser sends no Accept-Version with a preflight: the versions of a path answer it together.
  it('grants a preflight for a versioned path from the settings its versions share', async () => {
    const built = await serve(
      undefined,
      new Router('/v')
        .extend(version('1.0.0'))
        .get('/')
        .handler(() => 'v1'),
      new Router('/v')
        .name('V2')
        .extend(version('2.0.0'))
        .get('/')
        .handler(() => 'v2'),
    )

    const res = await built.request('/v', preflight(A, 'GET'))

    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toBe('GET')
  })

  it('refuses the preflight of a path whose versions disagree, and warns once', async () => {
    const warn = vi.fn()
    const built = createWebApplication()
      .logger(b => b.use({ ...newNoopLogger(), warn }))
      .with(corsPolicy(c => c.origins(A)))
      .mount(
        new Router('/v')
          .extend(version('1.0.0'))
          .get('/')
          .handler(() => 'v1'),
        new Router('/v')
          .name('V2')
          .extend(version('2.0.0'), cors(false))
          .get('/')
          .handler(() => 'v2'),
      )
    app = built
    await built.bootstrap()

    const first = await built.request('/v', preflight(A, 'GET'))
    await built.request('/v', preflight(A, 'GET'))

    expect(first.status).toBe(404)
    expect(corsHeaders(first)).toEqual({})
    expect(
      warn.mock.calls.filter(
        call => call[1] === 'Cannot answer a preflight: the routes behind it have different CORS settings',
      ),
    ).toEqual([
      [{ method: 'GET', path: '/v' }, 'Cannot answer a preflight: the routes behind it have different CORS settings'],
    ])
  })

  // find-my-way takes the two for one route: a preflight cannot tell which one it is for.
  it('refuses the preflight of routes the matcher files together under other parameter names', async () => {
    const built = await serve(
      undefined,
      new Router('/v')
        .extend(version('1.0.0'))
        .get('/:id')
        .handler(() => 'v1'),
      new Router('/v')
        .name('V2')
        .extend(version('2.0.0'), cors(false))
        .get('/:petId')
        .handler(() => 'v2'),
    )

    const res = await built.request('/v/7', preflight(A, 'GET'))

    expect(res.status).toBe(404)
    expect(corsHeaders(res)).toEqual({})
  })

  // The plugin answers what it grants before the path's own OPTIONS route runs, and leaves it the rest.
  it("answers a granted preflight ahead of the path's OPTIONS route, and leaves it any other", async () => {
    let ran = 0
    const own = new Router('/o').options('/').handler(() => {
      ran++
      return 'own'
    })
    own.get('/').handler(() => 'o')
    const built = await serve(undefined, own)

    const granted = await built.request('/o', preflight(A, 'GET'))

    expect(granted.status).toBe(204)
    expect(ran).toBe(0)

    const other = await built.request('/o', preflight('https://evil.example', 'GET'))

    expect(await other.text()).toBe('own')
    expect(corsHeaders(other)).toEqual({})
    expect(ran).toBe(1)
  })

  // The preflight table is find-my-way's: with a matcher of the application's own, a preflight for a constrained route
  // finds nothing and goes unanswered.
  it('grants no preflight for a constrained route under a matcher of its own', async () => {
    const built = createWebApplication()
      .server(() => ({ matcher: (flags, strategies) => findMyWayMatcher(flags, strategies) }))
      .with(corsPolicy(c => c.origins(A)))
      .mount(
        new Router('/v')
          .extend(version('1.0.0'))
          .get('/')
          .handler(() => 'v1'),
      )
    app = built
    await built.bootstrap()

    const res = await built.request('/v', preflight(A, 'GET'))

    expect(res.status).toBe(404)
    expect(corsHeaders(res)).toEqual({})
  })

  it('answers on the Node application the same way', async () => {
    const built = createNodeApplication()
      .with(corsPolicy(c => c.origins(A)))
      .mount(r())
    app = built
    await built.bootstrap()

    const res = await built.request('/r', preflight(A, 'POST', { 'access-control-request-headers': 'x-a' }))

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(corsHeaders(res)).toEqual({
      'access-control-allow-origin': A,
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'x-a',
    })
  })
})

describe('corsPolicy() refusals at start-up', () => {
  const x = (...extensions: Parameters<AnyRouter['extend']>) =>
    new Router('/x')
      .extend(...extensions)
      .get('/')
      .handler(() => 'x')

  it.each<[string, (c: CORSBuilder) => CORSBuilder, AnyRouter | undefined, string]>([
    ['no origin', c => c, undefined, 'Cannot build corsPolicy(): it names no origin'],
    [
      '"*" beside an origin',
      c => c.origins('*', A),
      undefined,
      'Cannot build corsPolicy(): "*" stands alone, with no other origin',
    ],
    [
      '"*" with credentials',
      c => c.origins('*').credentials(),
      undefined,
      'Cannot build corsPolicy(): a browser refuses credentials for every origin ("*")',
    ],
    [
      'an origin with a path',
      c => c.origins('https://app.example/x'),
      undefined,
      'Cannot build corsPolicy(): "https://app.example/x" is not an origin: an origin is a scheme, a host and a port',
    ],
    [
      'an allowed header that is not a header name',
      c => c.origins(A).allowedHeaders('bad header'),
      undefined,
      'Cannot build corsPolicy(): "bad header" is not a header name',
    ],
    [
      'an exposed header that is not a header name',
      c => c.origins(A).exposedHeaders('bad header'),
      undefined,
      'Cannot build corsPolicy(): "bad header" is not a header name',
    ],
    [
      'a maxAge under a second',
      c => c.origins(A).maxAge(500 * Millisecond),
      undefined,
      'Cannot build corsPolicy(): maxAge "500ms" is under a second',
    ],
    [
      'a route allowing "*" under credentials',
      c => c.origins(A).credentials(),
      x(cors({ origins: ['*'] })),
      'Cannot serve "GET /x": a browser refuses credentials for every origin ("*")',
    ],
    [
      'a route naming a member that is not a setting',
      c => c.origins(A),
      x(cors({ origin: '*' } as never)),
      'Cannot serve "GET /x": "origin" is not a CORS setting',
    ],
    [
      'a credentials setting that is not a boolean',
      c => c.config({ origins: [A], credentials: 'true' as never }),
      undefined,
      'Cannot build corsPolicy(): "credentials" must be true or false',
    ],
    [
      'a maxAge that is not a duration',
      c => c.config({ origins: [A], maxAge: '10m' as never }),
      undefined,
      'Cannot build corsPolicy(): "maxAge" must be a duration',
    ],
    [
      'a route whose setting is neither an object nor a boolean',
      c => c.origins(A),
      new Router('/x')
        .config(kCORSRoute, 'yes')
        .get('/')
        .handler(() => 'x'),
      'Cannot serve "GET /x": its CORS setting must be an object or a boolean',
    ],
  ])('refuses %s', async (_what, configure, router, message) => {
    const built = createWebApplication().with(corsPolicy(configure))
    if (router !== undefined) {
      built.mount(router)
    }
    app = built

    const booting = built.bootstrap()

    await expect(booting).rejects.toThrow(ErrConfiguration)
    await expect(booting).rejects.toThrow(message)
  })

  // A router's hooks never see a preflight, which matches no route.
  it('refuses a policy on a router', async () => {
    const built = createWebApplication().mount(
      new Router('/s')
        .with(corsPolicy(c => c.origins(A)))
        .get('/')
        .handler(() => 's'),
    )
    app = built

    await expect(built.bootstrap()).rejects.toThrow('Cannot install corsPolicy() on a router or a controller')
  })

  it('refuses a second policy on one server', async () => {
    const built = createWebApplication()
      .with(corsPolicy(c => c.origins(A)))
      .with(corsPolicy(c => c.origins(A)))
    app = built

    await expect(built.bootstrap()).rejects.toThrow('Cannot register plugin "caffeine-cors" twice')
  })
})
