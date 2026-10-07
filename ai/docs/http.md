# HTTP

Package: `@caffeinejs/http`. Adapter is Fastify.

```ts
import { createWebApplication, Controller, Get, Post, Args, $p } from '@caffeinejs/http'

@Controller('/examples')
export class ExampleController {
  @Get('/')
  getAll() {
    return this.list.execute()
  }

  @Post('/')
  @Args([$p.body()])
  createOne(input: { name: string }) {
    return this.create.execute(input.name)
  }
}

const app = createWebApplication().server(({ config }) => ({ listener: config.server }))

await app.run() // or app.run({ port: 3000 })
```

The adapter builds the Fastify instance itself; `.server(configure)` is how it is configured — `factory` for
Fastify's constructor options, `listener` for `listen()`. `.serverCallback(callback)` gets the setup context and the
bare instance before anything registers.

Side-effect-import the controller file from `main.ts` so `@Controller` registers.

- Routes: method decorators (`@Get`, `@Post`, …) on a `@Controller(path)` class. Constructor injection via `@Injectable` / the controller decorator’s dependency list.
- `@Args` / `$p` pick body, params, query — same idea as Kafka `$k`.
- `@Prefix` is a Fastify plugin prefix; `@Controller('/api/pets')` is the URL path, not a 404-scoped `/api` bubble.
- Errors: throw `ErrHTTPNotFound` (etc.). Render with `@Catch(ErrType)` on an `ErrorHandler` class, then enrol it with `.errorHandling(e => e.globalHandlers(H))`; or leave it unenrolled and name it with `@CatchWith`, or use a `@Catch` method on the controller. Enrolling two handlers for the same class fails at boot. See [errors.md](errors.md).

## HTTPS and HTTP/2

TLS and HTTP/2 are `factory` options, so configuration can switch them at `bootstrap()`:

```ts
createWebApplication({ config }).server(({ config }) => ({
  factory: { https: { key: config.tls.key, cert: config.tls.cert } },
  listener: config.server,
}))
```

- `https: { key, cert, ... }` serves TLS over HTTP/1.1.
- `http2: true` with `https` serves HTTP/2 over TLS. Add `allowHTTP1: true` to the TLS options to also answer
  HTTP/1.1 clients. Without `https`, `http2: true` is cleartext HTTP/2 (h2c), which browsers do not speak.
- `app.address.origin` starts with `https://` when the server serves TLS.

`app.instance` is a `FastifyInstance` whichever server was built. Narrow to reach what only the TLS server has:
`if (app.instance.server instanceof https.Server) app.instance.server.setSecureContext({ key, cert })` rotates a
certificate without a restart. Under HTTP/2, `ctx.req.raw` and `ctx.platform.reply.raw` are Node's
`Http2ServerRequest` and `Http2ServerResponse`, typed as their HTTP/1 counterparts. Narrow them with `instanceof`
for `stream`.

Two things differ under HTTP/2:

- HTTP/2 has no connection-specific headers. Node refuses or drops `Connection`, `Keep-Alive`,
  `Transfer-Encoding` and `Upgrade`, so do not set them with `@Header(...)` or `ctx.header(...)`.
- The host is in the `:authority` pseudo-header, not `host`. A custom constraint strategy has to read both.

## Serving under a base path

Behind a gateway or proxy that forwards `/api/...` with the prefix intact, `.basePath('/api')` serves the whole
application under it — or `.basePath(({ config }) => config.app.basePath)`, resolved at `bootstrap()`. Under Watt:
`.basePath(() => getBasePath({ throwOnMissing: false }) ?? undefined)` — the rest of running under Watt is
[docs/watt.md](../../docs/watt.md).

The server takes the base off a request's path before routing, so nothing the application declares changes:
routes from every source, plugin routes such as the health probes and static files, `app.use(path, …)` and
fallback-policy exceptions are all written as if served from the root. A request without the base is routed as it
came, so the base is not an access boundary: every route also answers without it, and keeping a route private is
the gateway's job or authorization's.

- `ctx.req.url` is the path the application sees; `ctx.req.basePath` is what was taken off (`''` when nothing was),
  so the base follows the request: a request that came without it is answered without it.
- Redirects the framework builds carry the base: cookie sign-in's `loginPath` / `accessDeniedPath` and the return
  URL, OAuth/OIDC's return URL and `defaultRedirectPath`, a `@caffeinejs/static` mount's `redirect` and `list`
  links, and the directory redirect of `sendFile` / `download`. A handler's own redirect says so with `~/`:
  `ctx.redirect('~/done')` is `/api/done`, while `ctx.redirect('/done')` is sent as written.
  `AuthenticationProperties.redirectURI` and the `returnTo` query of an OAuth/OIDC `loginPath` take `~/` too. A
  link in a page writes `ctx.req.basePath + '/done'`.
- The cookie scheme scopes its session and remember-me cookies to the base (`Path=/api`), so applications sharing
  an origin under different bases keep their sessions apart. The scope follows the request: a sign-in that came
  without the base writes them at `/`. `.path('/')` shares one session with requests that come without the base.
  Its `loginPath` and `accessDeniedPath` are written as the application sees them — `/login`, never `~/login`,
  which is refused.
- OAuth/OIDC `callbackURL` and `loginPath` are the URLs the browser sees, so they include the base. Their cookies
  stay at `Path=/` — `__Host-` cookies must — so applications sharing an origin give them distinct
  `sessionCookieName(...)` / `stateCookieName(...)`.
- `@caffeinejs/openapi` names the base as the document's server when the application named none, and links the
  docs page under it. A typed client takes the base in its URL: `brewer<App>('https://gateway.example/api')`.

## Cookies

Every application has cookies, on its own server and on every ops server; there is nothing to register. A request's
cookies are parsed when first read, so a hook or a plugin reads them wherever it sits.

```ts
ctx.req.cookie('theme') // string | undefined
ctx.cookie('theme', 'dark', { maxAge: 3600 })
ctx.deleteCookie('theme') // with the domain and path it was set with

ctx.cookie('cart', id, { signed: true }) // signed as the response goes out
await ctx.req.signedCookie('cart') // the value; false when it does not verify; undefined when absent

const result = await ctx.req.unsignCookie(ctx.req.cookie('cart') ?? '') // { valid, renew, value }
if (result.valid && result.renew) {
  ctx.cookie('cart', result.value, { signed: true }) // set again: signed with the first secret
}
```

- A cookie nobody scoped goes out with `Path=/` and `SameSite=Lax`. `.cookie(k => k.parseOptions({ ... }))` sets
  what every cookie starts from, and a call writing an option as `undefined` clears it. Under `.basePath('/api')`,
  `Path=/` reaches every application on the origin: scope a cookie with `path: ctx.req.basePath || '/'`.
- `.cookie(k => k.secret(secret))` signs with HMAC through Web Crypto, in the format `@fastify/cookie` writes, so
  cookies it signed keep verifying. A secret has at least 32 characters; `k.algorithm('SHA-512')` picks the hash. A
  signature covers the value alone: under one secret, a value signed for one cookie verifies under any other name, so
  a cookie whose value must not move between names takes a secret of its own.
- `k.secret([current, previous])` rotates: the first signs and any verifies. `ctx.req.unsignCookie(value)` answers
  `{ valid, renew, value }`, as `@fastify/cookie`'s `unsignCookie` does, with `renew` when `previous` verified it: set
  the cookie again, with the options it was set with, and it goes out signed with `current`. Drop `previous` once the
  cookies it signed have been set again or have expired.
- `k.signer(new MySigner())`, or the container key it is bound under — `k.signer(CookieSigner)` — signs with keys of
  the application's own. A key is resolved once per server, as it starts. A signer extends `CookieSigner`; its
  `unsign` answers `{ valid, renew, value }`, `renew` when a secret other than the first verified.
- A secret of the call's own, a tenant's, replaces the server's for that cookie:
  `ctx.cookie(name, value, { secret })` and `await ctx.req.signedCookie(name, secret)`.
- A cookie a browser would drop without a word is refused where it is set, with `ErrInvalidCookie`: a `__Host-`,
  `__Secure-`, `__Http-` or `__Host-Http-` name, in any case, without what its prefix needs; `SameSite=None` or
  `Partitioned` without `Secure`; a Domain that is not a domain name, or a Path that does not start with `/` or holds
  `;`, `<` or anything but spaces and printable US-ASCII; a name and value over 4096 bytes, its signature included.
  Whether a browser takes a Domain for the request's host is left to it.
- `secure: 'auto'` sets `Secure` on a request that came over HTTPS — behind a proxy, with `trustProxy` — and sends
  `SameSite=None` as `Lax` over plain HTTP. A prefixed name or `partitioned` has no such fallback: over plain HTTP it
  is refused. A browser takes `Secure` from `http://localhost`, so `secure: true` serves local development.
- The cookies are written by the server's first `onSend` hook. One a later plugin's `onSend` sets still goes out;
  a signed one is refused with `ErrCookieTooLate`. A route of a plugin registered in `.serverCallback()` cannot set
  cookies at all: register that plugin with `.with(...)`.
- `.cookie(k => k.enabled(false))` turns them off on every server: reading or setting one throws
  `ErrCookiesDisabled`, and a cookie-based authentication scheme refuses to start.
- A Fastify plugin that needs `@fastify/cookie`, such as `@fastify/session`, has the application register it beside
  the framework's: `.with(() => [fastifyCookie, { secret }])`. The context's cookies stay the framework's.

Authentication cookies:

- `sessionSecret` takes a list on the cookie scheme, OIDC, OAuth and GitHub: the first seals and any opens, and a
  session an older secret opened is sealed again under the first, keeping its expiry. A cookie-scheme session sealed
  by an earlier release, which does not record whether its cookie outlives the browser, is left to run out under the
  older secret. From the environment: `AUTH__SCHEMES__<NAME>__SESSION_SECRET__0`, `__1`, and on.
- Their cookies take every attribute from the scheme and none from `parseOptions`; their values still pass through
  its `encode` and `decode`, which must round-trip. The cookie scheme takes `domain(...)`, `partitioned()` and
  `priority(...)`; OIDC and OAuth take `cookieDomain(...)`, `cookiePartitioned()` and `cookiePriority(...)`, and a
  name they derive switches from `__Host-` to `__Secure-` when given a domain.
- Start-up refuses a cookie a browser would drop and two schemes writing cookies of one name.

Moving from the `@fastify/cookie` wrapper:

- `ctx.req.signedCookie(...)` answers with a promise: `await` it. `request.unsignCookie(value)` and
  `reply.unsignCookie(value)` are `await ctx.req.unsignCookie(value)`.
- Under `secure: 'auto'` over plain HTTP, `SameSite=None` goes out as `Lax`; `@fastify/cookie` wrote it as given, and
  a browser dropped it.
- A secret under 32 characters is refused, a `Buffer` secret is not taken, and an algorithm is named `SHA-256`,
  `SHA-384` or `SHA-512`.
- Cookies default to `Path=/`, `expires: 0` is the epoch, and `$p.signedCookie` gives `false` for an empty value.
- `request.cookies` and `reply.setCookie` exist only when the application registers `@fastify/cookie`, which no
  longer configures `ctx.req.signedCookie`.
- Authentication cookies take no attribute from `parseOptions`, only its `encode` and `decode`;
  `addStrategy(name, fn)` with a function that is not a class takes it as a container key.

## CSRF

`.with(csrf())` refuses a request that changes state from another origin, judged by what the browser says of it:
`Sec-Fetch-Site`, then `Origin` against the request's host. The approach of Go's `net/http` and ASP.NET Core: no
token, no cookie, and nothing for a page this application serves to do, since its own requests are `same-origin`.

```ts
const app = createWebApplication()
  .with(csrf((c, { config }) => c.config(config.app.csrf).trustedOrigins('https://admin.example.com')))
  .with(authentication())

@CSRFExempt() // a controller or a method: a webhook receiver, a form a partner's site posts here
@Controller('/webhooks')
class WebhooksController {}

newRouter('/hooks').with(csrfExempt()) // the programmatic form; csrfExempt(false) puts one route back under it
```

- `GET`, `HEAD`, `OPTIONS`, `TRACE` and `QUERY` are never checked: a safe method changes nothing, so an application
  that changes state on one has nothing to rely on.
- `Sec-Fetch-Site: same-origin` or `none` passes; `cross-site` and `same-site` are refused, a sibling subdomain
  being another origin. Without the header, `Origin` decides: absent, the request is a non-browser client's and
  passes; `null` or unreadable is refused; one naming the request's host passes and any other is refused, as is an
  `http:` origin on a request the server knows came over HTTPS.
- A refusal is a 403 with the code `ERR_CSRF_CROSS_ORIGIN`, in the standard error envelope, logged at `warn` with
  what decided it; the message never repeats a header value. `@Catch(ErrCSRFCrossOrigin)`, or a handler enrolled with
  `.errorHandling(e => e.globalHandlers(...))`, answers it differently.
- `c.trustedOrigins('https://admin.example.com')` lets a cross-origin request through from an exact
  `scheme://host[:port]`: a front end served from another origin, a partner's site posting a form, or the public
  origin of a proxy that rewrites `Host`. A path, a wildcard or `null` is refused at start-up with
  `ErrCSRFConfiguration`.
- The host and scheme an `Origin` is compared with are `ctx.req.host` and `ctx.req.protocol`, Fastify's
  `request.host` and `request.protocol`: they follow `X-Forwarded-Host` and `X-Forwarded-Proto` only under
  `trustProxy`, `.server(() => ({ factory: { trustProxy: true } }))`.
- `c.exclude('/webhooks')` leaves the routes registered under that prefix alone, whole segments only: `/webhooks`
  and `/webhooks/stripe`, not `/webhooks-old`, judged by the path a route was registered under, never the URL
  requested. For a route the application cannot mark; its own take `@CSRFExempt()`, `csrfExempt()`, or
  `csrfExemptConfig()` as the `config` of a raw Fastify route. A URL no route matched stays a 404.
- The check is a root `onRequest` hook of the server it is registered on, ahead of body parsing, in the slot
  `.with(csrf())` was written in: ahead of `.with(authentication())`, a cross-origin request is refused before anyone
  is authenticated; behind it, an anonymous one meets the challenge first. An [ops server](#ops-servers) is covered
  by its own `Ops('admin', o => o.with(csrf()))`, a route group alone by `router.plugin(csrf(c => c.name('admin')))`.
- From the environment, under whatever prefix the block has in the application's schema: `CSRF__ENABLED`,
  `CSRF__TRUSTED_ORIGINS__0`, `CSRF__EXCLUDE__0`. `c.enabled(false)` registers nothing.

Moving from `@fastify/csrf-protection`:

- There is no token, no `_csrf` cookie and no route handing a token out: delete the `/csrf` route, the
  `x-csrf-token` header the client sent and every `reply.generateCsrf()`. A browser needs nothing, and a non-browser
  client that used to send a token now sends nothing at all.
- `FST_CSRF_INVALID_TOKEN` and `FST_CSRF_MISSING_SECRET` become one refusal, `ERR_CSRF_CROSS_ORIGIN`, answered
  before the body is parsed.
- Every route of the server is covered, not only those the hook was attached to: exempt a route, or exclude its
  path.

## Programmatic routers

The second way to declare routes. Same compilation as a controller — same guards, authorization, validation, error
handling — with the configuration written as a chain instead of decorators.

```ts
import { $i } from '@caffeinejs/di'
import { $t } from '@caffeinejs/std/schema'
import { Router } from '@caffeinejs/http'

const pets = new Router('/pets')
  .inject({ svc: PetService }) // every route of the group, and of groups nested in it
  .authorize({ schemes: ['Bearer'] })

pets
  .get('/:id') // opens the route; ctx.req.param() is { id: string }
  .inject($i => ({ audit: $i.optional(Audit) })) // or a plain spec, as the group above
  .schema({ params: $t.Object({ id: $t.Integer() }) }) // now { id: number }
  .handler((ctx, deps) => deps.svc.find(ctx.req.param().id))

pets.group('/:petID/orders', r =>
  r
    .post('/')
    .schema({ body: CreateOrder })
    .handler((ctx, deps) => deps.svc.order(ctx.req.body())),
)

app.mount(pets) // before app.bootstrap()
```

- A verb takes `(path)`, `(path, handler)` or `(path, schema, handler)`. With a handler the route is closed there
  and then and the group comes back, so routes chain off one another either way:

  ```ts
  pets
    .get('/', (ctx, deps) => deps.svc.all())
    .get('/:id', { params: $t.Object({ id: $t.Integer() }) }, (ctx, deps) => deps.svc.find(ctx.req.param().id))
  ```

- An inline route is closed, so `.name()`, `.authorize()`, `.guards()`, `.with()` and `.inject()` are unreachable on
  it and its dependencies are the group's. A route needing any of those opens the chain and closes it with
  `.handler(fn)`.
- `.inject()` takes a spec or a function handed `$i`, on both `Router` and the route chain — so `optional`, `allOf`,
  `provide` and `config` are reachable without importing it. Both forms type `deps` identically.
- The handler takes the context first and the injected dependencies second — `undefined` when nothing was injected.
- `ctx.req.body()` is the parsed body. `ctx.req.param()` / `.query()` / `.header()` are typed from the schema, and
  path parameters are typed from the path when no schema declares them.
- `.group(path, fn)` nests; `.mount(...routers)` (or `.mount(path, ...routers)`) composes ones written elsewhere. A
  nested group starts from its parent's configuration and dependencies and may override them. The same router
  mounted twice into one host is added once.
- Route names default to method + path (`get_pets_id`) and are what the OpenAPI operationId is built from.
  `.name('find')` pins one.
- `.with(ext, ...)` applies extensions — how a package configures a route it does not own. http ships
  `bodyAsBuffer()`, `bodyAsStream()`, `fst(options)`, `compress(opts)` and `encoding(tokens)`; openapi ships
  `operation(detail)` and `apiGroup(detail)`. Each is the same implementation as its decorator.
- `.plugin(factory)` registers a Fastify plugin in front of that router's routes and the groups nested under
  it. Only a router bound to Fastify takes one, so it is created with `newRouter(path)` rather than
  `new Router(path)` —
  `newRouter('/pets').plugin(() => [fastifyCors, { origin: 'https://pets.example' }])`.
  A router from `new Router(path)` is bound to no adapter and mounts on any application.
  There is no `corsPlugin`/`compressPlugin` wrapper — register the third-party plugin directly, the same as any
  other Fastify plugin. A factory returns the plugin, or the plugin paired with the options to register it
  with; an official plugin already wraps itself in `fastify-plugin`, so a wrapper written only to carry its
  options would be encapsulated and reach no routes. The same on a controller is
  `@Use(factory)` above `@Controller`. A router takes only plugins, never features, and nothing is
  deduplicated: two groups wanting different settings pass two factories. The factory's context carries
  `config` as `ConfigSnapshot<unknown>` — a router does not know which application it will be mounted into.
- `fst({ ... })` is the Fastify escape hatch: lifecycle hooks, `attachValidation`, `logLevel`, custom compilers —
  everything Fastify takes except what the router already decides (`method`, `url`, `schema`, `config`, `handler`,
  `bodyLimit`, `handlerTimeout`).
- A router accumulates its routes in its type: `RoutesOf<typeof app>` is the whole surface, ready for a typed
  client. What carries them is the value `.handler()` returns, so a chain gathers them all.
- Writing routes as separate statements leaves one such value each. `blend(...routers)` unions them into one
  router — as do `.mount(...)` and `app.mount(...)`, which take several. The variable the routes were opened from
  carries none of them.

```ts
export const pets = new Router('/pets')
  .with(apiGroup({ name: 'Pets' }))
  .get('/')
  .handler(list)
  .get('/:id')
  .with(operation({ operationId: 'getPet' }))
  .handler(find)

type API = RoutesOf<typeof pets> // { method: 'GET', path: '/pets', ... } | { method: 'GET', path: '/pets/:id', ... }

// the same surface, written as statements
const owner = new Router('/pets')
const all = owner.get('/').handler(list)
const one = owner.get('/:id').handler(find)

export const petsRouter = blend(all, one)
```

## Authorization declarations

`@Authorize` / `@Roles` / `@AllowAnonymous` and the routers' `.authorize({ ... })` are one mechanism, and
declarations **add up**: none replaces another, on one route or across the levels above it.

- One `roles` list is satisfied by **any** of its roles; separate declarations are **each** required.
  `@Roles('admin', 'manager')` is "admin or manager"; `@Roles('admin')` next to `@Roles('manager')`, or on the
  controller and on the method, is "both". Every policy named, at any level, has to pass.
- A router nested in another adds to what its parent declared. It can never widen it.
- A bare `@Authorize()` asks for the default policy (an authenticated caller) and keeps applying when a more
  specific level names a policy of its own. Naming only `schemes` is bare too: schemes pick who authenticates.
- `@AllowAnonymous` / `{ allowAnonymous: true }` opens what declares nothing below it. The most specific
  declaration wins: a method with `@Authorize` inside a public controller is protected, and a method with
  `@AllowAnonymous` inside a protected controller is public.
- `authz.requireAuthenticatedByDefault()` (or `fallbackPolicy(...)`) gates every route that declares nothing —
  the ones a plugin registered straight on Fastify included. Open under it: a route declared public, the health
  probes, OAuth callbacks, a URL no route matches (404), the prefixes in `{ except: ['/assets/'] }`, and a plain
  Fastify route registered with `config: authenticationExempt()`.
- A route naming several `schemes` advertises every one of them on a 401. A custom handler adds its challenge with
  `ctx.appendHeader('WWW-Authenticate', ...)`, not `ctx.header(...)`, which would replace the others'.
- A policy must hold at least one requirement. `addPolicy('x', p => {})` fails at start-up
  (`ERR_AUTHZ_POLICY_EMPTY`): it would be satisfied by every caller, anonymous included.
- A policy only asks what it says. `p.assert(...)` alone admits an anonymous caller that satisfies it; add
  `p.requireAuthenticated()` when an identity is part of the rule.

## Health

`.with(healthProbes())` mounts `/livez`, `/readyz` and `/startupz`. The probes answer from `ApplicationHealth`
(`@caffeinejs/std/health`), which every application has — headless ones too — so any other caller, such as a
readiness check a host polls, a custom route or a test, reads the same instance as `app.health`, or injects it, and
shares one evaluation with the routes. The evaluation budgets are the `Health()` feature's:
`.install(Health(h => h.cacheTTL('2s')))` tunes them with or without the probes mounted.

```ts
const app = createWebApplication()
  .install(Health(h => h.cacheTTL('2s')))
  .with(healthProbes())
await app.run()

const readiness = await app.health.readiness() // { ok, checks, outcomes }
```

- An indicator is a singleton bean extending `HealthIndicator`; `@Injectable()` auto-extends it. It joins
  `readiness` unless its `groups` say otherwise — keep dependencies out of `liveness`. `critical: false` reports
  `degraded` instead of failing the probe.
- The budgets set on `Health()` — `indicatorTimeout`, `probeDeadline`, `cacheTTL` — apply to every caller, probes
  mounted or not. Without `Health()`, `ApplicationHealth` runs on 2 s, 3 s and 1 s.
- Readiness and startup fail until `run()` marks the application started. Under Watt, answer its checks from
  `app.health` as [docs/watt.md](../../docs/watt.md) shows.
- To serve the probes on an [ops server](#ops-servers), register the plugin there:
  `Ops('admin', o => o.with(healthProbes()))`. They stay exempt from authentication there, and the application's own
  server serves them only if its `.with(...)` registers them too.

## Ops servers

An ops server is one more port, serving only the routers bound to it: metrics, probes or an admin API kept off the
public one. Each is named, and an application may install several.

```ts
const app = createWebApplication({ config })
  .install(
    Authentication(a =>
      a
        .addBasic('ops', b => b.validate(checkOperator))
        .addJWTBearer('api', j => j.secret(SECRET))
        .default('api'),
    ),
  )
  .install(
    Ops('admin', (o, { config }) =>
      o
        .server(() => ({ listener: config.app.admin }))
        .with(authentication())
        .with(healthProbes())
        .use(AuditLog),
    ),
  )
  .with(authentication())
  .mount(
    newRouter('/jobs')
      .with(bindTo('admin'))
      .authorize({ schemes: ['ops'], roles: ['operator'] })
      .get('/', () => jobs.list()),
  )

@BindTo('admin')
@Controller('/metrics')
export class MetricsController {}

await app.run()
app.ops.get('admin')?.address // { host, port, origin }
```

- **Binding is per router.** `@BindTo(name)` on a controller and `router.with(bindTo(name))` bind every route under
  it. A router nested in a bound one is served where its parent is: binding it to another server is refused at
  start-up, and so is a name no installed server has. `group.boundTo` on `app.routeGroups` names the server.
- **What it gets.** The ops server is built through the same path as the application's own server: the same request
  context, error handlers, not-found envelope, cookies, global guards and start-up checks. What a router asks for
  itself follows it: `router.plugin(...)` or `@Use(...)`, and `router.guards(...)` or `@UseGuards(...)`.
- **Plugins and middleware are per server.** `o.with(...)`, `o.use(...)` and `o.useFn(...)` take what the
  application's `.with(...)`, `.use(...)` and `.useFn(...)` take, and install on that server alone, after the same
  head slots. Nothing registered on the application reaches an ops server, an authentication gate included, and
  `.basePath(...)` and `.serverCallback(...)` never do.
- **Settings.** `o.server(...)` takes what `.server(...)` takes, `{ factory, listener }`, so TLS and HTTP/2 are
  switched by configuration there too.
- **Authorization.** There is nothing ops-specific: a route on an ops server requires what its router or controller
  declares, `router.authorize(...)` or `@Authorize(...)`, and an undeclared one, or one a plugin registers straight
  on the server, answers to the application's fallback policy, exactly as on the application's own server. Health
  probes stay exempt.

  Authenticating on an ops server takes a gate registered there, `o.with(authentication())`: the application's gate
  does not cover it, and start-up refuses a protected route no gate covers. The OIDC login routes go to the first
  gate to install. The application's own server is built first, so its gate takes them when it has one;
  `authentication(g => g.oidcRoutes(false))` keeps them off an ops server's gate.

- **Lifecycle.** `run()` listens on the application's own server first, then on each ops server on its own
  `listener`; what `run(...)` is given does not reach them. `close()` closes the application's own server first, so
  probes and metrics answer through the drain.
- **Clients and tests.** A typed client reaches ops routes given that server's origin:
  `brewer<App>(app.ops.get('admin')!.address!.origin)`. A test injects with `app.ops.get('admin')!.fetch('/jobs')`;
  `app.fetch(...)` reaches the application's own server only.
- **OpenAPI.** `@caffeinejs/openapi` documents the server it is registered on, so routes bound to an ops server are
  left out of the main document.

## Typed client — `@caffeinejs/brewer`

The front-end half of the same types. No codegen, no schema file: the server's type _is_ the client's contract.

```ts
import { brewer } from '@caffeinejs/brewer'
import type { App } from './server/app.js' // export type App = typeof app

const client = brewer<App>('http://localhost:3000')

const res = await client.pets({ id: 1 }).get() // GET /pets/1
if (res.ok) {
  const pet = await res.json() // typed from the route's 200 schema
}

await client.pets.post({ body: { name: 'Rex' } })
```

- Static segments are properties; a parameterised segment is a call taking that one parameter. The path is never
  written out.
- A verb ends the chain. Returns a `Response` whose `.json()` is typed — checking `res.ok` is yours.
- `brewer<typeof app>`, `brewer<typeof someRouter>` and `brewer<RoutesOf<typeof app>>` all work, so a package can
  ship a client for just its own routes.
- The routes are the ones the application declares. An application served under a `.basePath(...)` puts the base
  in the URL — `brewer<App>('https://gateway.example/api')` — which the path is joined onto, never resolved
  against.
- Given the application instead of a URL, requests go through its own `fetch` and never reach a socket — which is
  how to test one. Both the routes and the transport come from the argument, so neither the type argument nor the
  URL is written. The application must be `bootstrap()` first, or every call answers 404:

  ```ts
  await app.bootstrap()
  const client = brewer(app)
  await client.pets({ id: 1 }).get()

  brewer<typeof petsRouter>(app) // one router's surface, driven through the application
  ```

  The target is structural — anything with a matching `fetch` works, a stub included — and `options.fetch` still
  wins over it.

- Zero runtime dependencies and browser-safe. The front-end needs `@caffeinejs/http` as a **devDependency** only to
  resolve the `App` type — `import type` is erased, so nothing ships.
- Escape hatch for a path built at run time, or a segment named after a verb:
  `client.$request('GET', '/pets/:id', { params: { id: 1 } })`.
- Static: `.with(staticFiles(s => s.serve(root, { prefix: '/static' })))`. That serves files. It is not SPA history fallback — for a single-page application see [spa.md](spa.md), which is routing the application writes. Default `@fastify/static` `wildcard: true` will 404 missing files under the prefix, not return `index.html`.
