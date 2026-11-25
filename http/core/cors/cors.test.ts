import { newNoopLogger } from '@caffeinejs/application/logger'
import { Millisecond, Minute, Second } from '@caffeinejs/std/duration'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWebApplication } from '../../application.js'
import type { IContext } from '../../context.js'
import { node } from '../../platform/node.testkit.js'
import { version } from '../constraints/route.js'
import { ErrConfiguration } from '../error/common.js'
import { findMyWayMatcher } from '../matcher/find_my_way.js'
import { ErrRouteConflict } from '../matcher/matcher.js'
import { Router } from '../routing/programmatic/programmatic.js'
import { Authentication } from '../security/auth/auth.js'
import { BaseAuthenticationHandler } from '../security/auth/handler.js'
import { AuthenticateResult, AuthenticationTicket } from '../security/auth/ticket.js'
import { Claim, Identity, Principal } from '../security/identity.js'
import { authentication } from '../security/security.js'
import { cors, corsPolicy, type CORSBuilder } from './cors.js'

// Any router, as `mount` takes them: the route types each carries are not under test here.
type AnyRouter = Router<any, any, any, any, any>

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
    .config(cors(false))
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
      .config(cors({ origins: [PARTNER] }))
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
      .listener('admin', l =>
        l.with(corsPolicy(c => c.origins(A))).mount(new Router('/jobs').get('/').handler(() => 'jobs')),
      )
      .mount(new Router('/own').get('/').handler(() => 'own'))
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
      .config(cors(true))
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
        .config(version('1.0.0'))
        .get('/')
        .handler(() => 'v1'),
      new Router('/v')
        .name('V2')
        .config(version('2.0.0'))
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
          .config(version('1.0.0'))
          .get('/')
          .handler(() => 'v1'),
        new Router('/v')
          .name('V2')
          .config(version('2.0.0'), cors(false))
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
        .config(version('1.0.0'))
        .get('/:id')
        .handler(() => 'v1'),
      new Router('/v')
        .name('V2')
        .config(version('2.0.0'), cors(false))
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
          .config(version('1.0.0'))
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
    const built = createWebApplication({ adapter: node() })
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
  const x = (...inputs: Parameters<AnyRouter['config']>) =>
    new Router('/x')
      .config(...inputs)
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
        .config({ cors: 'yes' } as never)
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

  // A policy on a server serves no route of its own: the application's `OPTIONS` route stays, and its preflights are
  // still answered first.
  it("keeps an application's own OPTIONS route under a server's policy", async () => {
    const built = createWebApplication()
      .with(corsPolicy(c => c.origins(A)))
      .mount(
        new Router()
          .options('/')
          .handler(() => 'own options')
          .get('/', () => 'root'),
      )
    app = built
    await built.bootstrap()

    const own = await built.request('/', { method: 'OPTIONS' })
    const pre = await built.request('/', preflight(A, 'GET'))

    expect([own.status, await own.text(), pre.status]).toEqual([200, 'own options', 204])
  })

  // Two policies are the user's to register: on a server neither serves a route, both start, and the first one answers
  // a preflight.
  it('starts two policies on one server, and answers a preflight with the first', async () => {
    const built = createWebApplication()
      .with(corsPolicy(c => c.origins(A)))
      .with(corsPolicy(c => c.origins(PARTNER)))
      .mount(new Router('/two').get('/', () => 'two'))
    app = built
    await built.bootstrap()

    const res = await built.request('/two', preflight(A, 'GET'))

    expect([res.status, corsHeaders(res)['access-control-allow-origin']]).toEqual([204, A])
  })
})

describe('corsPolicy() on a router', () => {
  async function routed() {
    const built = createWebApplication().mount(
      new Router('/s')
        .with(corsPolicy(c => c.origins(A)))
        .get('/x')
        .handler(() => 's'),
      new Router('/plain').get('/').handler(() => 'plain'),
    )
    app = built
    await built.bootstrap()
    return built
  }

  // Its `OPTIONS` route under the router is what a preflight to the router's routes matches.
  it("answers a preflight to the router's routes", async () => {
    const res = await (await routed()).request('/s/x', preflight(A, 'GET'))

    expect(res.status).toBe(204)
    expect(corsHeaders(res)).toEqual({
      'access-control-allow-origin': A,
      'access-control-allow-methods': 'GET',
    })
  })

  it("allows an actual request to the router's routes", async () => {
    const res = await (await routed()).request('/s/x', { headers: { origin: A } })

    expect(res.status).toBe(200)
    expect(corsHeaders(res)).toEqual({ 'access-control-allow-origin': A })
  })

  // It covers its scope alone: a sibling's routes stay without CORS.
  it('leaves the routes outside the router alone', async () => {
    const built = await routed()

    const actual = await built.request('/plain', { headers: { origin: A } })
    const pre = await built.request('/plain', preflight(A, 'GET'))

    expect(corsHeaders(actual)).toEqual({})
    expect([pre.status, corsHeaders(pre)]).toEqual([404, {}])
  })

  // Its `OPTIONS` route catches every preflight under the router's path: one for a route it does not cover, such as a
  // sibling router's at a longer path, is not its to grant.
  it('leaves a preflight for a route under its path that it does not cover', async () => {
    const built = createWebApplication().mount(
      new Router('/api')
        .with(corsPolicy(c => c.origins(A).credentials(true)))
        .get('/x')
        .handler(() => 'x'),
      new Router('/api/admin').delete('/users/:id').handler(() => 'gone'),
    )
    app = built
    await built.bootstrap()

    const res = await built.request('/api/admin/users/1', preflight(A, 'DELETE'))

    expect([res.status, corsHeaders(res)]).toEqual([404, {}])
  })

  // Each policy on a router serves `OPTIONS` routes at its path: two at one path hold the same routes.
  it('refuses two policies on routers at the same path at start-up', async () => {
    const built = createWebApplication().mount(
      new Router('/api')
        .with(corsPolicy(c => c.origins(A)))
        .get('/a')
        .handler(() => 'a'),
      new Router('/api')
        .with(corsPolicy(c => c.origins(PARTNER)))
        .get('/b')
        .handler(() => 'b'),
    )
    app = built

    await expect(built.bootstrap()).rejects.toThrow(ErrRouteConflict)
  })

  // The policy's `OPTIONS /*` is a route like any other: under its path it is more specific than a broader one of the
  // application's, and answers a plain `OPTIONS` request there with the 404 a path no route matches gets.
  it("answers a plain OPTIONS request under its path before an application's broader OPTIONS route", async () => {
    const built = createWebApplication()
      .mount(
        new Router('/api')
          .with(corsPolicy(c => c.origins(A)))
          .get('/data')
          .handler(() => 'data'),
      )
      .mount(new Router().options('/*', () => 'app'))
    app = built
    await built.bootstrap()

    const [under, outside] = await Promise.all([
      built.request('/api/data', { method: 'OPTIONS' }),
      built.request('/other', { method: 'OPTIONS' }),
    ])

    expect([under.status, outside.status, await outside.text()]).toEqual([404, 200, 'app'])
  })

  // A path that ends in an optional parameter or a wildcard has no children: the policy serves its `OPTIONS` route there
  // alone, and the router starts. A "?" inside a segment is no optional parameter: the path keeps its children.
  it.each([
    ['/pets/:id?', '/', ['/pets', '/pets/1']],
    ['/:id?', '/', ['/', '/42']],
    ['/files/*', '/', ['/files/a/b']],
    ['/item-:id?', '/data', ['/item-123/data']],
    // The whole last segment is optional, its text included; and a "*" after a parameter is text, not a wildcard.
    ['/reports/:id.json?', '/', ['/reports', '/reports/42.json']],
    ['/download/:id-file*name', '/child', ['/download/7-file*name/child']],
  ])('answers preflights under a router at %s', async (path, route, urls) => {
    const built = createWebApplication().mount(
      new Router(path)
        .with(corsPolicy(c => c.origins(A)))
        .get(route)
        .handler(() => 'ok'),
    )
    app = built
    await built.bootstrap()

    const statuses = await Promise.all(urls.map(async url => (await built.request(url, preflight(A, 'GET'))).status))

    expect(statuses).toEqual(urls.map(() => 204))
  })

  // A router with a group prefix serves its root with and without the trailing slash: so does the policy's `OPTIONS`.
  it.each(['/tenants/r', '/tenants/r/'])("answers a preflight to a prefixed router's root at %s", async url => {
    const built = createWebApplication().mount(
      new Router()
        .extend((group: { prefix(prefix: string): unknown }) => {
          group.prefix('/tenants/:id?')
        })
        .with(corsPolicy(c => c.origins(A)))
        .get('/', () => 'root'),
    )
    app = built
    await built.bootstrap()

    const [res, served] = await Promise.all([built.request(url, preflight(A, 'GET')), built.request(url)])

    expect([served.status, res.status, corsHeaders(res)['access-control-allow-origin']]).toEqual([200, 204, A])
  })

  // An `OPTIONS` route outside the policy's scope answers its own path: the policy's hooks do not run in front of it.
  it("leaves a preflight to a sibling router's OPTIONS route to that route", async () => {
    const built = createWebApplication().mount(
      new Router('/api')
        .with(corsPolicy(c => c.origins(A)))
        .get('/task')
        .handler(() => 'task'),
      new Router('/api').options('/task', () => 'sibling'),
    )
    app = built
    await built.bootstrap()

    const res = await built.request('/api/task', preflight(A, 'GET'))

    expect([res.status, await res.text(), corsHeaders(res)]).toEqual([200, 'sibling', {}])
  })

  // The policy's own `OPTIONS` routes are no target of a preflight: one asking for a versioned route of the
  // application's at the same path is answered from that route's settings.
  it("answers a preflight for a versioned OPTIONS route of the application's at the policy's path", async () => {
    const built = createWebApplication().mount(
      new Router('/api')
        .config(version('1.0.0'))
        .with(corsPolicy(c => c.origins(A)))
        .options('/', () => 'own'),
    )
    app = built
    await built.bootstrap()

    const res = await built.request('/api', preflight(A, 'OPTIONS'))

    expect([res.status, corsHeaders(res)['access-control-allow-origin']]).toEqual([204, A])
  })

  // An `OPTIONS` route of the application's at the policy's own path holds the route the policy serves there.
  it("refuses an unconstrained OPTIONS route of the application's at the policy's path at start-up", async () => {
    const built = createWebApplication().mount(
      new Router('/api').with(corsPolicy(c => c.origins(A))).options('/', () => 'own'),
    )
    app = built

    await expect(built.bootstrap()).rejects.toThrow(ErrRouteConflict)
  })

  // An `OPTIONS` route of the application's under the policy's path: the policy answers its preflights first, and a
  // plain `OPTIONS` request reaches it.
  it("answers the preflights of an OPTIONS route of the application's under its path, and leaves it the rest", async () => {
    const built = createWebApplication().mount(
      new Router('/api')
        .with(corsPolicy(c => c.origins(A)))
        .options('/task', () => 'own')
        .get('/task', () => 'task'),
    )
    app = built
    await built.bootstrap()

    const pre = await built.request('/api/task', preflight(A, 'GET'))
    const plain = await built.request('/api/task', { method: 'OPTIONS' })

    expect([pre.status, corsHeaders(pre)['access-control-allow-origin'], plain.status, await plain.text()]).toEqual([
      204,
      A,
      200,
      'own',
    ])
  })

  // A browser sends no Accept-Version with a preflight: the router's version must not keep it from the policy.
  it("answers a preflight to a versioned router's routes", async () => {
    const built = createWebApplication().mount(
      new Router('/ver')
        .config(version('1.0.0'))
        .with(corsPolicy(c => c.origins(A)))
        .get('/x')
        .handler(() => 'x'),
    )
    app = built
    await built.bootstrap()

    const res = await built.request('/ver/x', preflight(A, 'GET'))

    expect([res.status, corsHeaders(res)['access-control-allow-origin']]).toEqual([204, A])
  })

  // The policy's own `OPTIONS` route catches preflights; it is no route a preflight can ask for, whether the server
  // finds a preflight's route in its matcher or, with a constrained route, in a table of its own.
  it.each([
    ['unconstrained', {}],
    ['versioned', version('1.0.0')],
  ])('answers a preflight asking for OPTIONS at a path no route serves with a 404, %s', async (_, options) => {
    const built = createWebApplication().mount(
      new Router('/s')
        .config(options)
        .with(corsPolicy(c => c.origins(A)))
        .get('/x')
        .handler(() => 's'),
    )
    app = built
    await built.bootstrap()

    const res = await built.request('/s/missing', preflight(A, 'OPTIONS'))

    expect([res.status, corsHeaders(res)]).toEqual([404, {}])
  })

  it('answers a preflight for a method the route lacks with a 404', async () => {
    const res = await (await routed()).request('/s/x', preflight(A, 'DELETE'))

    expect([res.status, corsHeaders(res)]).toEqual([404, {}])
  })
})
