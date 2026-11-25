# HTTP

Package: `@caffeinejs/http`. One application, `createWebApplication()` from `@caffeinejs/http`, serves on the
web-standards engine, and a server adapter runs it on a runtime. `adapter: node()`, from `@caffeinejs/http-node`,
listens on a node:http, node:https or node:http2 server. `adapter: bun()`, from `@caffeinejs/http/bun`, listens with
`Bun.serve`. With no adapter the application has no socket of its own: the runtime calls `app.fetch`, as Deno and
workers do. `authentication()`, `csrf()`, `cors()`, `corsPolicy()`, `healthProbes()`, cookies and error handling are
imported from `@caffeinejs/http` and run under every adapter. `compression()`, `decompression()` and their
decorators are imported from `@caffeinejs/http/compress`.

```ts
import { Controller, Get, Post, Args, $p, createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http-node'

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

const app = createWebApplication({ adapter: node() }).server(({ config }) => ({ listen: config.server }))

const { address } = await app.run() // or app.run({ port: 3000 }); address.origin is the URL it serves
```

`.server(configure)` configures the server it builds. `bodyLimit`, `handlerTimeout`, `trustProxy`, `router`,
`requestIDHeader` and `schemaCompiler` are the engine's, under every adapter; the adapter adds its own. Under `node()`,
`listen` takes node:net's listen options and `http`, `https` and `http2` the node server's own; `run(options)` takes
node:net's `ListenOptions`, merged over `listen` key by key. `app.instance` is the node:http, node:https or node:http2
server, and `.serverCallback(callback)` gets the setup context, with the configuration, and that server before it
listens. `factory` and `listener` are refused at start-up.

Under `bun()`, `listen` takes node:net's names too (`host`, `port`, `path`, `reusePort`, `ipv6Only`), and `https` the
`key`, `cert`, `ca` and `passphrase`, so a configuration limited to those serves on both runtimes. What Bun cannot honor
is refused at start-up: the `http` and `http2` sections and any other `listen` or `https` option, each pointing at
`node()`, and an `https` section that lacks the key or the certificate. `app.instance` is Bun's server once `run()` has
started it, and `.serverCallback(...)` gets it right after `Bun.serve` started it:

```ts
import { createWebApplication } from '@caffeinejs/http'
import { bun } from '@caffeinejs/http/bun'

const app = createWebApplication({ config, adapter: bun() }).mount(pets)
const { address } = await app.run({ port: 3000 })
```

The adapter's types are inferred from `adapter`. Naming the configuration's type turns that inference off, as naming
any type argument does, so name the adapter's type too. With the configuration's alone, the application takes any
adapter's settings and types `app.instance` as `unknown`:

```ts
import { node, type NodeAdapter } from '@caffeinejs/http-node'

const app = createWebApplication<AppConfig, NodeAdapter>({ config, adapter: node() })
```

With no adapter, start the application and hand `app.fetch` to the runtime:

```ts
import { createWebApplication } from '@caffeinejs/http'

const app = createWebApplication({ config }).mount(pets)
await app.run()

export default { fetch: app.fetch } // Deno, workers
```

Side-effect-import the controller file from `main.ts` so `@Controller` registers.

- Routes: method decorators (`@Get`, `@Post`, …) on a `@Controller(path)` class. Constructor injection via `@Injectable` / the controller decorator’s dependency list.
- `@Args` / `$p` pick body, params, query — same idea as Kafka `$k`.
- `@Prefix` goes before the controller's path; `@Controller('/api/pets')` is the URL path, not a 404-scoped `/api` bubble.
- Errors: throw `ErrHTTPNotFound` (etc.). Render with `@Catch(ErrType)` on an `ErrorHandler` class, then enrol it with `.errorHandling(e => e.globalHandlers(H))`; or leave it unenrolled and name it with `@CatchWith`, or use a `@Catch` method on the controller. Enrolling two handlers for the same class fails at boot. See [errors.md](errors.md).

## Server capabilities and background work

Every request has a stable `ctx.server`. Its `remoteAddress` reads the current peer reported by the adapter, the
same address as `$p.address()`. Use `ctx.platform` for native request objects and Fetch runtime arguments.

| Entry point                                                    | `ctx.server.remoteAddress`  | Who owns `ctx.server.waitUntil`                                                             |
| -------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| Node or Bun socket                                             | Socket peer, when available | The serving listener                                                                        |
| `app.request(input, init?)` on any adapter                     | Synthetic loopback          | The local engine                                                                            |
| Direct `app.fetch(request)` on a Node or Bun listening adapter | Synthetic loopback          | The local engine                                                                            |
| Adapter-free `app.fetch(request, ...runtime)`                  | `undefined`                 | Absent by default. A configured `fetchWaitUntil` can supply this invocation’s host binding. |

Register an already-started promise before handing off the response. Registration is allowed during `onSend`.
A saved method called after handoff, expiry, or forced shutdown throws `ErrWaitUntilClosed`. Caffeine observes
the supplied promise even when registration fails. Task rejections are logged with the request ID. If the response
depends on the result, await the operation in the handler.

This route skips optional telemetry when background work is unavailable. Its task captures only the request ID and
has a one-second timeout independent of the client connection.

```ts
import { Router } from '@caffeinejs/http'
import { Second } from '@caffeinejs/std/duration'

const routes = new Router('/')
routes.get('/ready').handler(ctx => {
  const waitUntil = ctx.server.waitUntil
  if (waitUntil) {
    const task = fetch('https://telemetry.example/events', {
      method: 'POST',
      body: ctx.req.id,
      signal: AbortSignal.timeout(Second),
    }).then(async response => {
      await response.body?.cancel()
      if (!response.ok) throw new Error(`Telemetry returned HTTP ${response.status}`)
    })
    waitUntil(task)
  }
  return 'ready'
})
```

The response and request-scoped dependencies finish on their normal lifecycle. Use application-owned services for
work that can outlive the request. A disconnect can end the response stream while registered work continues.
Graceful shutdown waits for accepted work before `onClose` and application disposal. Forced shutdown stops waiting.

### Bind a Fetch host

In a Cloudflare Worker with `nodejs_compat`, bootstrap the application at module scope. The default matcher can
register the schema-free `/ready` route above during module initialization. The Worker calls
`app.fetch(request, env, execution)` for each request. On the request’s first access to `ctx.server`, Caffeine
calls the resolver with `[env, execution]`. Bind the method to that invocation’s execution context.
Returning `undefined` leaves the capability absent for that request.

```ts
import { createWebApplication } from '@caffeinejs/http'

const app = createWebApplication().mount(routes)
app.server(() => ({
  fetchWaitUntil: ([, execution]) => {
    if (
      typeof execution === 'object' &&
      execution !== null &&
      'waitUntil' in execution &&
      typeof execution.waitUntil === 'function'
    ) {
      return execution.waitUntil.bind(execution)
    }
    return undefined
  },
}))
await app.bootstrap()
export default { fetch: app.fetch }
```

Caffeine calls the binding synchronously with a promise that fulfills after the task settles and any rejection has
been logged. If the binding throws, `waitUntil` throws that error to its caller. If the binding returns a promise
that rejects, Caffeine logs the host error with the request ID. In either case, shutdown stops waiting for that
registration and Caffeine continues to observe the task. If the binding’s promise fulfills while the task is
pending, shutdown still waits for the task. The host sets the invocation’s execution limits. [Cloudflare Workers context](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)

If you bootstrap inside the Worker’s `fetch` handler, `workerd` rejects the default matcher’s attempt to generate
code during route registration. For request-time bootstrap, configure a matcher that can register those routes
without generating code. A matcher supplied by an earlier `.server(() => ({ matcher }))` call stays in effect
when you add `fetchWaitUntil` as shown above. The local integration test uses an exact-path matcher for its
schema-free routes. It reads the entire response before releasing the registered task and observing its
completion through a service binding. [Worker fixture](../../test/fixtures/http-wait-until/worker.mjs)

## HTTPS and HTTP/2

TLS and HTTP/2 are `.server(...)` sections under `node()`, so configuration can switch them at `bootstrap()`:

```ts
createWebApplication({ config, adapter: node() }).server(({ config }) => ({
  https: { key: config.tls.key, cert: config.tls.cert },
  listen: config.server,
}))
```

- `https: { key, cert, ... }` serves TLS over HTTP/1.1. `http` takes node:http's options for an HTTP/1.1 server, and
  is refused beside `http2`.
- `http2: true` with `https` serves HTTP/2 over TLS. `http2: { allowHTTP1: true }`, which needs `https`, also answers
  HTTP/1.1 clients. Without `https`, `http2: true` is cleartext HTTP/2 (h2c), which browsers do not speak.
- `app.address.origin` starts with `https://` when the server serves TLS.

`app.instance` is whichever server was built. Narrow to reach what only the TLS server has:
`if (app.instance instanceof https.Server) app.instance.setSecureContext({ key, cert })` rotates a certificate without
a restart. Under HTTP/2, `ctx.platform.incoming` and `ctx.platform.outgoing` are Node's `Http2ServerRequest` and
`Http2ServerResponse`. Narrow them with `instanceof` for `stream`.

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
  URL, OAuth/OIDC's return URL and `defaultRedirectPath`. A handler's own redirect says so with `~/`:
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

Every application has cookies, on its own server and on every listener; there is nothing to register. A request's
cookies are parsed when first read, so a hook or a plugin reads them wherever it sits.

```ts
ctx.req.cookie('theme') // string | undefined
ctx.cookie('theme', 'dark', { maxAge: 1 * Hour }) // a Duration, from @caffeinejs/std/duration; Max-Age=3600
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
- `.cookie(k => k.secret(secret))` signs with HMAC through Web Crypto. A secret has at least 32 characters; `k.algorithm('SHA-512')` picks the hash. A
  signature covers the value alone: under one secret, a value signed for one cookie verifies under any other name, so
  a cookie whose value must not move between names takes a secret of its own.
- `k.secret([current, previous])` rotates: the first signs and any verifies. `ctx.req.unsignCookie(value)` answers
  `{ valid, renew, value }`, with `renew` when `previous` verified it: set
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
  a signed one is refused with `ErrCookieTooLate`.
- `.cookie(k => k.enabled(false))` turns them off on every server: reading or setting one throws
  `ErrCookiesDisabled`, and a cookie-based authentication scheme refuses to start.

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

## CSRF

`.with(csrf())` refuses a request that changes state from another origin, judged by what the browser says of it:
`Sec-Fetch-Site`, then `Origin` against the request's host. The approach of Go's `net/http`: no token, no cookie,
and nothing for a page this application serves to do, since its own requests are `same-origin`.

```ts
const app = createWebApplication()
  .with(csrf((c, { config }) => c.config(config.app.csrf).trustedOrigins('https://admin.example.com')))
  .with(authentication())

@Controller('/webhooks')
class WebhooksController {
  @CSRFExempt() // the receiver alone: a webhook sender, a form a partner's site posts here
  @Post('/github')
  github() {}

  @Post('/secret') // stays checked: it rotates the signing secret
  rotate() {}
}

// On a controller, @CSRFExempt() exempts every method, one added later included; @CSRFExempt(false) keeps one checked
new Router('/hooks').config(csrfExempt()) // the programmatic form; csrfExempt(false) puts one route back under it
```

- `GET`, `HEAD`, `OPTIONS`, `TRACE` and `QUERY` are never checked: a safe method changes nothing, so an application
  that changes state on one has nothing to rely on.
- `Sec-Fetch-Site: same-origin` or `none` passes; `cross-site` and `same-site` are refused, a sibling subdomain
  being another origin. Without the header, `Origin` decides: absent, the request is a non-browser client's and
  passes; `null` or unreadable is refused; one naming the request's host passes and any other is refused, as is an
  `http:` origin on a request the server knows came over HTTPS.
- A refusal is a 403 with the code `ERR_CSRF_CROSS_ORIGIN`, in the standard problem body, logged at `warn` with
  what decided it and the path, never the query; the message never repeats a header value.
  `@Catch(ErrCSRFCrossOrigin)`, or a handler enrolled with `.errorHandling(e => e.globalHandlers(...))`, answers it
  differently.
- `c.trustedOrigins('https://admin.example.com')` lets a cross-origin request through from an exact
  `scheme://host[:port]`: a front end served from another origin, a partner's site posting a form, or the public
  origin of a proxy that rewrites `Host`. A path, a wildcard or `null` is refused at start-up with
  `ErrCSRFConfiguration`.
- The host and scheme an `Origin` is compared with are `ctx.req.host` and `ctx.req.protocol`, the scheme
  lower-cased: they follow `X-Forwarded-Host` and `X-Forwarded-Proto` only under `trustProxy`,
  `.server(() => ({ trustProxy: true }))`. Under `node()` and `bun()` `trustProxy` names the proxy, as `true`, a list
  of addresses, CIDR ranges or `loopback`, `linklocal` and `uniquelocal`: a hop count is refused. With no adapter the
  application knows no peer address and takes `true` alone.
- `c.exclude('/webhooks')` leaves the routes registered under that prefix alone, whole segments only: `/webhooks`
  and `/webhooks/stripe`, not `/webhooks-old`, judged by the path a route was registered under, never the URL
  requested. For a route the application cannot mark; its own take `@CSRFExempt()` or `csrfExempt()`. A URL no route
  matched stays a 404.
- A route's own mark wins over a path: `csrfExempt(false)` keeps a route under an excluded prefix protected.
  `c.exclude('/')`, which would cover every route, is refused at start-up; `c.enabled(false)` turns the check off.
- The check is a root `onRequest` hook of the server it is registered on, ahead of body parsing, in the slot
  `.with(csrf())` was written in: ahead of `.with(authentication())`, a cross-origin request is refused before anyone
  is authenticated; behind it, an anonymous one meets the challenge first. A [listener](#listeners) is covered by its
  own `.listener('admin', l => l.with(csrf()))`, a route group alone by `router.with(csrf(c => c.name('admin')))`.
- From the environment, under whatever prefix the block has in the application's schema: `CSRF__ENABLED`,
  `CSRF__TRUSTED_ORIGINS__0`, `CSRF__EXCLUDE__0`. `c.enabled(false)` registers nothing, and says so once, at `warn`,
  as the server starts.

Custom checks, for an origin no exact list can spell:

```ts
csrf(c =>
  c
    // Every https subdomain: compare the hostname and the scheme, never a prefix of the string
    .trustOrigin((_ctx, { protocol, hostname }) => protocol === 'https:' && hostname.endsWith('.example.com'))
    // A tenant's own front end, by the host the request came to
    .trustOrigin((ctx, origin) => frontEnds.get(ctx.req.host) === origin.origin)
    // Pages on sibling subdomains
    .allowSecFetchSite((_ctx, site) => site === 'same-site'),
)
```

- A check only lets through. It is asked once the exemptions, the rules and `trustedOrigins(...)` have refused a
  request, never about one they let through.
- `trustOrigin` is asked about an `http:` or `https:` origin alone, handed as a fresh `URL` that holds the origin and
  nothing else. `Origin: null`, a malformed origin, and an `http:` origin on a request known to be HTTPS stay refused
  whatever it answers. `https://app.example.com` is a prefix of `https://app.example.com.evil.example`: compare
  `hostname`.
- `allowSecFetchSite` is asked about `same-site` or `cross-site` alone, once every `trustOrigin` check has declined,
  and only when the request carries an origin `trustOrigin` could be asked about. A browser too old to send the
  header is never asked about. `same-site` takes in every subdomain, one a user can publish to or one taken over
  included; naming the hosts with `trustOrigin` is narrower.
- Only `true`, or a promise of it, lets the request through. A check that throws or rejects fails the request with
  its error, a 500 for a plain `Error`. Each call adds a check; they are asked in the order written, and the first
  `true` wins.
- A check runs before the body is read and, written ahead of `.with(authentication())`, before anyone is
  authenticated, so `ctx.user` is not set yet. Any page can make its visitors' browsers send a request that asks it:
  keep it cheap, and cache a lookup.
- A check is code: `c.config(...)` carries none, and a block's `trustedOrigins` stands beside it.

Webhooks:

- A delivery from the sender's servers carries neither `Sec-Fetch-Site` nor `Origin`, so it passes with no
  configuration, whatever its content type: JSON, or form-encoded as Twilio and Slack post theirs.
- Exempt the receiver when the sender sets an `Origin` of its own, or when the callback comes back through the
  user's browser, such as a 3-D Secure return or a SAML POST. One that arrives with `Origin: null` after a
  cross-origin redirect can only be exempted: no trusted origin or check takes it.
- An exempt receiver authenticates every delivery itself, by a signature over the bytes it was sent, read with
  `bodyAsBuffer()`: a forgery from a victim's browser now reaches it.
- Keep the exemption narrow, `c.exclude('/webhooks/github')` or `@CSRFExempt()` on the receiver method: the route
  that rotates the signing secret sits beside it. Under an exempt controller, mark that route `@CSRFExempt(false)`.
- Exempting a receiver from the check does not open it to anonymous callers: under
  `Authorization(z => z.requireAuthenticatedByDefault())`, declare it public as well.

Limitations:

- `Sec-Fetch-Site` is sent only to HTTPS origins and `localhost`; a plain-HTTP site is judged by `Origin` alone.
- An `https:` `Origin` naming this host passes on a request the server sees as `http`, as a proxy that ended TLS
  without being trusted delivers it. Only this host's own HTTPS side can send it, and over plain HTTP a browser
  posting from there sends `Origin: null`, which is refused, unless the page asked for a permissive referrer policy.
  Serve over HTTPS, with HSTS, and name the proxy in `trustProxy`.
- A proxy or an extension that strips both headers makes a browser's request look like a non-browser client's,
  which passes. The cookie scheme's `SameSite=lax` is the second layer.
- An origin `corsPolicy()` allows is not trusted here: list it in `trustedOrigins(...)` as well.
- A plugin registered ahead of `.with(csrf())` that answers a request from its own hook answers it unchecked, and
  one that rewrites the request's method there decides which method is checked.
- A URL no route matched is the not-found handler's, which is never checked: it must not change state.
- A page served from this origin is this origin: HTML a user uploaded and the application serves back posts as
  `same-origin`. Serve user content from another origin.
- A WebSocket upgrade is a `GET`, and is not checked: an endpoint authenticated by cookie checks the handshake's
  `Origin` itself.
- An origin of another scheme, such as `capacitor://localhost` or `tauri://localhost`, can be neither trusted nor
  checked, only exempted.

## Programmatic routers

The second way to declare routes. Same compilation as a controller — same guards, authorization, validation, error
handling — with the configuration written as a chain instead of decorators.

```ts
import { $t } from '@caffeinejs/application/schema'
import { $i } from '@caffeinejs/di'
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

- An inline route is closed, so `.name()`, `.authorize()`, `.guards()`, `.extend()` and `.inject()` are unreachable on
  it and its dependencies are the group's. A route needing any of those opens the chain and closes it with
  `.handler(fn)`.
- `.inject()` takes a spec or a function handed `$i`, on both `Router` and the route chain — so `optional`, `allOf`,
  `provide` and `config` are reachable without importing it. Both forms type `deps` identically.
- The handler takes the context first and the injected dependencies second — `undefined` when nothing was injected.
- `ctx.req.body()` is the parsed body. `ctx.req.param()` / `.query()` / `.header()` are typed from the schema, and
  path parameters are typed from the path when no schema declares them.
- `.group(path, fn)` nests; `.mount(...routers)` (or `.mount(path, ...routers)`) composes ones written elsewhere. A
  nested group starts from its parent's configuration and dependencies and may override them. The same router
  mounted twice into one host is added once. A router nested in itself, directly or through the routers under it,
  is refused at start-up.
- Route names default to method + path (`get_pets_id`) and are what the OpenAPI operationId is built from.
  `.name('find')` pins one.
- `.config(...)` on a route or a router sets the options a plugin reads for it:
  `cors(options)`, `csrfExempt()`, `compress(options)`, `decompress(codings)`, `version(v)`, `constraint(name, value)`
  and, from the caching package, `cacheControl(options)` and `cacheInvalidate(options)`. Each is the same
  implementation as its decorator, and `@RouteOptions(...)` sets them on a controller or a method. A route's
  constraints add to its router's by name; `.config({ constraints: null })` drops every one it inherits.
- `.extend(ext, ...)` applies the other extensions — how a package configures a route it does not own. http ships
  `bodyAsBuffer()` and `bodyAsStream()`; openapi ships `operation(detail)` and `apiGroup(detail)`.
  Each is the same implementation as its decorator.
- `.with(factory)` registers a plugin in front of that router's routes and the groups nested under it, taking what
  the application's `.with(...)` takes: a factory that returns an `HTTPPlugin` ([Plugins](#plugins)). A router from
  `new Router(path)` mounts on either application; a handler narrows `ctx.platform` on `name === 'node'` to reach
  Node's request and response. The same on a controller is `@Use(factory)` above `@Controller`. A router takes only plugins, never
  features, and nothing is deduplicated: two groups wanting different settings pass two factories. The factory's context carries
  `config` as `ConfigSnapshot<unknown>` — a router does not know which application it will be mounted into.
- A router accumulates its routes in its type: `RoutesOf<typeof app>` is every route `app.mount(...)` took, ready for
  a typed client; a listener's are those of the routers it mounts, `RoutesOf<typeof router>`. What carries them is the value `.handler()` returns, so a chain gathers them all.
- Writing routes as separate statements leaves one such value each. `blend(...routers)` unions them into one
  router — as do `.mount(...)` and `app.mount(...)`, which take several. The variable the routes were opened from
  carries none of them.

```ts
export const pets = new Router('/pets')
  .extend(apiGroup({ name: 'Pets' }))
  .get('/')
  .handler(list)
  .get('/:id')
  .extend(operation({ operationId: 'getPet' }))
  .handler(find)

type API = RoutesOf<typeof pets> // { method: 'GET', path: '/pets', ... } | { method: 'GET', path: '/pets/:id', ... }

// the same surface, written as statements
const owner = new Router('/pets')
const all = owner.get('/').handler(list)
const one = owner.get('/:id').handler(find)

export const petsRouter = blend(all, one)
```

## Responses

What a handler returns is what the client gets, and the same holds for a `Responder`, a catch handler and
`ctx.body(...)`:

| A handler returns                                     | The client gets                                        |
| ----------------------------------------------------- | ------------------------------------------------------ |
| a plain object, an array, a number, a boolean, `null` | JSON                                                   |
| a string                                              | text                                                   |
| a `Blob` or a `File`                                  | its bytes, streamed, with its size as `Content-Length` |
| an `ArrayBuffer`, a `Uint8Array` or any typed array   | its bytes                                              |
| a web `ReadableStream` or a Node `Readable`           | its bytes as the stream produces them, chunked         |
| a `Response`                                          | its status, its headers and its body, streamed         |
| `Attachment(body, options)`                           | a download, named, served in ranges: see below         |
| nothing                                               | an empty `200`                                         |

- Bytes and streams go out under the type the route declared with `.produces(...)` or `@Produces`, or the handler
  set with `ctx.header('content-type', ...)`; failing that a `Blob`'s own type; failing that
  `application/octet-stream`. A `Response` keeps the headers it was built with, and takes the route's type only when
  it carries none.
- A `HEAD` is answered as the `GET` would be, without the body.
- A `Response` loses the headers that describe one connection: `Connection`, the ones it names, `Keep-Alive`,
  `Transfer-Encoding` and the rest of RFC 9110's list. A `Response` from `fetch(...)` holds its body decoded, so it
  also loses the `Content-Encoding` and `Content-Length` of the bytes it was sent as. One built in the handler keeps
  both: `new Response(gzipped, { headers: { 'content-encoding': 'gzip' } })` sends the bytes as they are. So does
  `new Response(upstream.body, upstream)`, which copies a fetched one: delete both from the copy's headers.
- `ctx.body(...)` takes a value, never a promise: it throws `ErrConfiguration` for one, which would go out as `{}`.
  Await it first, or return the promise from the handler.
- `ctx.notFound(...)`, `ctx.badRequest(...)` and the other error helpers, and an `ErrHTTP`'s `body`, keep their own
  status over a `Response`'s: `ctx.notFound(new Response('gone'))` is a `404`.

### Downloads

`Attachment(body, { name, type, etag, lastModified })` sends a `Blob`, bytes or a stream as a download:

```ts
import { Attachment, Router } from '@caffeinejs/http'

const exports = new Router('/exports').get('/q3').handler(async () => {
  const report = await reports.q3()
  return Attachment(report.csv, { name: 'relatório Q3.csv', type: 'text/csv', etag: `"${report.version}"` })
})
```

- `Content-Disposition` names the file twice: a plain `filename`, and the exact name as UTF-8 in `filename*`, which
  current clients prefer. A `File` is named after itself when `name` is not given.
- A name is one file, never a place: `../../etc/passwd` is saved as `passwd`, and `C:\reports\q3.pdf` as `q3.pdf`.
  Control characters and the marks that reorder text are dropped, and a name that leaves nothing, `..` or `dir/`,
  names no file.
- Preconditions come before any range, in RFC 9110's order, on a `GET` or a `HEAD` that would get `200`:
  - An `If-Match` listing no tag that matches `etag` strongly, so never a weak one, or, without `If-Match`, an
    `If-Unmodified-Since` before `lastModified`, is refused: `Attachment` throws `ErrHTTPPreconditionFailed`, and
    error handling answers `412`, through a `@Catch` handler when one names it. `If-Match: *` holds for any body,
    one without an `etag` included.
  - A client that holds the content already gets `304` and no body: an `If-None-Match` listing `etag`, compared
    weakly, or `*`; or, without `If-None-Match`, an `If-Modified-Since` not before `lastModified`.
  - A date that is not an HTTP-date, in any of RFC 9110's three forms, is ignored.
  - A stream the `412` or the `304` leaves unread is closed. Another method is the handler's to guard: it has acted
    by the time `Attachment` answers.
- A `Blob` or bytes are served in ranges, so a large download cut off part-way resumes, and every answer says
  `Accept-Ranges: bytes`. A `GET` with one `Range` gets `206` and that part. Several go out together as
  `multipart/byteranges`, in the order asked for, each part under the type the whole body would carry. A range past
  the end is left out, and `416` answers when none is left. A body the reply gives a `Content-Encoding` is sent whole
  to several ranges: a multipart answer cannot carry that coding. One range of it is a part of its coded bytes.
- A malformed range, another unit, more than 100 ranges, ranges adding up to more than the body, a `HEAD`, or a status
  other than `200` get the whole body. Under `HTTPCaching`, a `Range`, `If-Match` or `If-Unmodified-Since` request
  skips the store and reaches the handler, and a part is never stored. With `Cache-Control: only-if-cached`, which
  forbids reaching the handler, a `Range` gets the stored whole body, or `504` when none is stored, and a
  precondition gets `504`.
- `If-Range` resumes only the same content: it must match `etag` exactly, or `lastModified` to the second when
  `lastModifiedStrong: true` says the content cannot change twice within one second. A weak `etag`, or a date without
  that flag, never resumes. Otherwise the whole current body goes out, so a client never splices two versions
  together.
- An `etag` is quoted, `'"v42"'`. An unquoted one, or a `lastModified` that is not a valid date, throws
  `ErrConfiguration`: either would be a validator no client can match. So does a `type` holding a control
  character, which no header value may.
- A stream is sent whole, since its length is not known. So is a `Blob` past 4 GiB: Node's `Blob.slice` cannot cut a
  part out of one.
- `fs.openAsBlob` reports a file past 4 GiB at its size modulo 2^32 (Node 22 and 24). Serve such a file with
  `@caffeinejs/static`'s `sendFile` when its build lists it, or as a stream otherwise.

## Compression

`compression()`, from `@caffeinejs/http/compress`, compresses answers. It is off until registered, on the application,
a listener, a router or a controller, and covers that scope's routes.

```ts
import { compression } from '@caffeinejs/http/compress'
import { KiB } from '@caffeinejs/std/bytes'

app.with(
  compression(c =>
    c
      .encodings('zstd', 'br', 'gzip')
      .threshold(2 * KiB)
      .br({ quality: 5 }),
  ),
)
```

- An answer is compressed in the coding the client rates highest among those offered, `zstd`, `br`, `gzip` and
  `deflate` in that order by default, when its `Content-Type` is compressible (text, JSON, XML, JavaScript; never
  `text/event-stream` nor `application/octet-stream`) and its size, when known, is at least the threshold, `1 * KiB`
  by default. A stream of unknown size is compressed and flushed chunk by chunk, so a feed stays a feed.
- Such an answer varies on `Accept-Encoding` whichever coding goes out, identity included. A compressed one keeps
  its `ETag`, and drops `Accept-Ranges`, `Content-Digest`, `Repr-Digest` and `Content-MD5`: they describe the identity
  bytes. A `Range` request still gets identity bytes.
- Left as they are: an answer already carrying a `Content-Encoding`, a `204` and a `205`, and one that says
  `Cache-Control: no-transform`. A `206` and a `304` are never coded, and vary on `Accept-Encoding` unless their
  type is one it never compresses. A client that accepts no coding offered, `identity;q=0` included, gets identity, never a `406`.
- Settings: `encodings`, `threshold`, `gzip({ level })` and `deflate({ level })` (1 to 9, default 6),
  `br({ quality })` (0 to 11, default 4), `zstd({ level })` (1 to 19, default 3) and `compressible(type => ...)`.
  `config(config.app.compression)` reads them from the configuration tree; a fluent
  setter wins over it. A bad setting fails start-up with `ErrConfiguration`.
- Per route: `compress({ ... })` or `@Compress({ ... })` sets members over the plugin's, `compress(false)` turns it
  off, `compress(true)` turns it back on under a group's `false`. `@Gzip()`, `@Brotli()`, `@Zstd()` and `@Deflate()`
  offer that coding alone, identity otherwise, and take its level or quality: `@Gzip({ level: 9 })`. One coding
  decorator per method; for several, `@Compress({ encodings: [...] })`.
- Register it once, where it covers the routes it should, and tune a route with `compress(...)`: two over one route
  both run, and the inner one finds the answer already coded.
- Order: its hooks run after a route's own and after those of plugins registered before it in its scope or in an
  outer scope. Register `HTTPCaching` before it in the same scope, or in an outer one, so the cache stores identity
  bytes; under it on a router, the cache stores none of the answers it coded, unless the route's key varies on
  `Accept-Encoding`.
- A static mount's routes nest under the scope `staticFiles()` is registered in and take its route options: on a
  router, `.config(compress(false))` reaches its files. On the server's `.with(...)`, nothing reaches them: register
  `compression()` on the routers that should compress to keep a mount's files identity. A variant the build wrote
  goes out as it is.
- Compressing a secret beside input the request reflects lets an attacker who sees response sizes guess the secret
  (BREACH). Turn such a route off with `compress(false)`.

## Request decompression

`decompression()`, from `@caffeinejs/http/compress`, decodes request bodies sent with a `Content-Encoding`. It is
off until registered, on the application, a listener, a router or a controller, and covers that scope's routes.

```ts
import { decompression } from '@caffeinejs/http/compress'

app.with(decompression(d => d.encodings('gzip', 'br')))
```

- A `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS` or `QUERY` body sent with a `Content-Encoding` the route decodes is
  decoded before it is parsed or streamed, and the route's `bodyLimit` holds the decoded bytes, so a small body that
  inflates past it is a `413`. Another coding, or more than one, is a `415` whose `Accept-Encoding` lists what the
  route decodes; bytes that are not the coding they claim are a `400`. `ctx.req.raw` stays the request as received.
- Settings: `encodings(...codings)`, every coding (`zstd`, `br`, `gzip`, `deflate`) by default.
  `config(config.app.decompression)` reads them from the configuration tree. An empty list or an unknown coding fails
  start-up with `ErrConfiguration`.
- Per route: `decompress('gzip')` or `@Decompress('gzip')` sets a route's own list, `decompress(false)` decodes
  nothing, and a method's list replaces its controller's.
- Register it once, where it covers the routes it should, and tune a route with `decompress(...)`.

## Plugins

A `.with(...)` factory returns an `HTTPPlugin`: a class whose `register(context)` does the work, handed the same
context the factory got. `context.server` is the server the plugin is registered on, scoped to where it is
registered: its `name` (a listener's, `undefined` for the application's own), `basePath`, `prefix` (where the scope's
routes start), router flags and `address` once it listens, and what the plugin may do there: `mount(...routers)`,
`use(...)`, `useFn(...)` and `hook(name, fn)`, taking what `app.mount`, `app.use`, `app.useFn` and `app.hook` take.

```ts
import { HTTPPlugin, Router, type HTTPPluginFactory, type HTTPSetupContext } from '@caffeinejs/http'

class Metrics extends HTTPPlugin {
  register({ server, container }: HTTPSetupContext): void {
    const registry = container.get(MetricsRegistry)
    server.mount(new Router('/metrics').get('/', () => registry.render()))
    server.use(countRequests)
  }
}

export function metrics(): HTTPPluginFactory {
  return () => new Metrics()
}

app.with(metrics()) // the application's own server
app.listener('admin', l => l.with(metrics())) // that listener alone
new Router('/api').with(metrics()) // that router alone: /api/metrics
```

Where it is registered decides what `context.server` reaches. Each place is a scope of its own: its hooks and
middleware cover its routes and the scopes nested in it, never a sibling's.

- **On a server** (`.with(...)`, `l.with(...)`): the server serves what it mounts. Its middleware joins that
  server's pipeline after the application's own `.use(...)` entries, and a path is the server's own.
- **On a router** (`router.with(...)`): it registers on each server the router is mounted on, once per place it is
  mounted at, after that server's own plugins; `context.server.prefix` is the router's path there. What it mounts
  nests under the router, starting from its path, guards and plugins. Its middleware runs in front of the router's
  routes alone, nested groups included, and a path is relative to the router: `use('/jobs', mw)` on a router at
  `/admin` covers `/admin/jobs`. A relative path under a router whose path holds a wildcard or an optional parameter
  is refused at start-up.
- **On a controller** (`@Use(...)`): it registers on the server serving the controller, after the routers'. Its
  middleware runs in front of the controller's routes alone, a path relative to the controller and its `@Prefix`, and
  what it mounts nests under the controller, starting from its declarations.

Register a plugin once, where it covers the routes it should, and tune a route through its options (`compress(...)`,
`cors(...)`, `.config({ html: ... })`): two copies over one route both run, each as it registered: no check refuses a
second plugin of one name; two `authentication()` gates under one label over one route are refused, as which one
authenticates would be ambiguous. `context.server.hasPlugin(name)` answers for the plugin's own scope and the ones
around it: the routers or controller it is nested in, then the server. `corsPolicy()` on a server answers preflights
whatever route they match; on a router or a controller it serves `OPTIONS /` and `OPTIONS /*` under that path, so an
`OPTIONS` route of the application's at either path, or a second policy on a router at the same path, fails start-up
with `ErrRouteConflict`.

- Mounted routes compile as `app.mount(...)` compiles them: guards, authorization and the fallback policy, CSRF
  marks, routers' own `.with(...)` and the start-up checks. Mark a group the application does not own
  `detail('http', { internal: true })` so the OpenAPI document leaves it out. The groups stay out of
  `app.routeGroups`, and a router mounted twice in one place, or one the application already serves on that server,
  is served once.
- An `HTTPPlugin` mounts `new Router(...)` routers and runs on both applications; a handler it mounts narrows
  `ctx.platform` on `name` to reach Node's request.
- A plugin that depends on a feature asks `context.hasFeature(name)` and throws `ErrFeatureNotInstalled`.
- `context.server`'s operations are open only while the plugin registers. A middleware factory, a server callback
  and a context kept past its registration are refused. `.server(...)`, `.basePath(...)`, a listener's callback and
  a route-option configurer run before any server exists, and their context has no `server`.

Hooks:

- `app.hook(name, fn)` adds one to the application's own server, `l.hook(...)` to a listener's, and
  `context.server.hook(...)` to a plugin's scope. An `onRoute` hook may write `route.options` under keys of its own,
  frozen once `onRoute` returns, and `ctx.options` reads them on each request. The names are `onRequest`,
  `preHandler`, `onSend`, `onResponse`, `onError`, `onRoute`, `onReady` and `onClose`. A request hook has no path and
  no `next`: it answers with `ctx.body(...)` and fails by throwing.
- Plugin hooks run in the order the plugins are installed, and all of them run before the middleware chain. Headers
  that must reach a 401 the gate answers go in an `onRequest` hook of a plugin installed before `authentication()`:
  `examples/04-spa-dashboard/api/spa/security.ts` writes `helmet`'s headers that way: it checks that
  `ctx.platform.name` is `'node'`, then reads `{ incoming, outgoing }` as a `NodeContextPlatform`.

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
  the routes a plugin mounts included. Open under it: a route declared public (`@AllowAnonymous`,
  `.authorize({ allowAnonymous: true })`), a static mount marked `anonymous: true`, the health probes, OAuth
  callbacks and a URL no route matches (404).
- A route naming several `schemes` advertises every one of them on a 401. A custom handler adds its challenge with
  `ctx.header('WWW-Authenticate', ..., { append: true })`, not a plain `ctx.header(...)`, which would replace the
  others'.
- A policy must hold at least one requirement. `addPolicy('x', p => {})` fails at start-up
  (`ERR_AUTHZ_POLICY_EMPTY`): it would be satisfied by every caller, anonymous included.
- A policy only asks what it says. `p.assert(...)` alone admits an anonymous caller that satisfies it; add
  `p.requireAuthenticated()` when an identity is part of the rule.

## Health

`.with(healthProbes())` mounts `/livez`, `/readyz` and `/startupz`. The probes answer from `ApplicationHealth`
(`@caffeinejs/application/health`), which every application has — headless ones too — so any other caller, such as a
readiness check a host polls, a custom route or a test, reads the same instance as `app.health`, or injects it, and
shares one evaluation with the routes. The evaluation budgets are the `Health()` feature's:
`.install(Health(h => h.cacheTTL(2 * Second)))` tunes them with or without the probes mounted.

```ts
const app = createWebApplication({ adapter: node() })
  .install(Health(h => h.cacheTTL(2 * Second)))
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
- The probes skip the authentication gate, the application's global guards and its authorization, so the kubelet never
  sees a 401 or 403 from them. Root hooks and middleware still run for them: a middleware that refuses requests
  without a credential must let the probe paths through.
- To serve the probes on a [listener](#listeners), register the plugin there:
  `.listener('admin', l => l.with(healthProbes()))`. They skip access control there too, and the application's own
  server serves them only if its `.with(...)` registers them too.

## Listeners

A listener is one more port, serving only the routers mounted on it and the controllers bound to it: metrics,
probes or an admin API kept off the public one. Each is named, and an application may add several.

```ts
const jobsRouter = new Router('/jobs').authorize({ schemes: ['ops'], roles: ['operator'] }).get('/', () => jobs.list())

const app = createWebApplication({ config, adapter: node() })
  .install(
    Authentication(a =>
      a
        .addBasic('ops', b => b.validate(checkOperator))
        .addJWTBearer('api', j => j.secret(SECRET))
        .default('api'),
    ),
  )
  .listener('admin', (l, { config }) =>
    l
      .server(() => ({ listen: config.app.admin }))
      .with(authentication())
      .with(healthProbes())
      .use(AuditLog)
      .mount(jobsRouter),
  )
  .with(authentication())

@BindTo('admin')
@Controller('/metrics')
export class MetricsController {}

await app.run()
app.listeners.get('admin')?.address // { host, port, path, origin }
```

- **Adding one.** `.listener(name, configure)` takes the name at once and refuses one already added. `configure`
  runs at start-up with the builder and the context a plugin factory gets (`config`, `logger`, `container`), so the
  example above reads `config.app.admin` there.
- **From a feature.** A feature adds a listener from its configure step with `listenersOf(kit).add(name, configure)`,
  which takes the same arguments; `listenersOf` refuses an application that is not a web application. A feature does
  not know which application installs it, so it names the settings type it writes: `NodeServerSettings`, from
  `@caffeinejs/http-node`, for a `listen` section, which an application under no adapter refuses at start-up.

  ```ts
  protected configure(kit: FeatureConfigureKit<C>): void {
    listenersOf<C, NodeServerSettings>(kit).add('metrics', l =>
      l.server(() => ({ listen: { port: this.#port } })).with(metrics()),
    )
  }
  ```

- **What a listener serves.** The routers mounted on it with `l.mount(...)`, nested routers included, and the
  controllers bound to it with `@BindTo(name)`. A name no installed server has is refused at start-up.
  `group.boundTo` on `app.routeGroups` names the server.
- **What it gets.** A listener is built through the same path as the application's own server: the same request
  context, error handlers, not-found problem, cookies, global guards and start-up checks. What a router asks for
  itself follows it: `router.with(...)` or `@Use(...)`, and `router.guards(...)` or `@UseGuards(...)`.
- **Plugins and middleware are per server.** `l.with(...)`, `l.use(...)` and `l.useFn(...)` take what the
  application's `.with(...)`, `.use(...)` and `.useFn(...)` take, and install on that server alone, after the same
  head slots. Nothing registered on the application reaches a listener, an authentication gate included, and
  `.basePath(...)` and `.serverCallback(...)` never do. What a plugin registered with `l.with(...)` mounts or adds
  through `context.server` lands on that server alone.
- **Settings.** `l.server(...)` takes what the application's `.server(...)` takes: `NodeServerSettings` under
  `node()`, `BunServerSettings` under `bun()`, `ServerSettings` under none. TLS and HTTP/2 are switched by configuration there too.
- **Authorization.** There is nothing listener-specific: a route on a listener requires what its router or controller
  declares, `router.authorize(...)` or `@Authorize(...)`, and an undeclared one answers to the application's fallback policy, exactly as on the application's own server. Health
  probes stay exempt.

  Authenticating on a listener takes a gate registered there, `l.with(authentication())`: the application's gate
  does not cover it, and start-up refuses a protected route no gate covers. The OIDC login routes go to the first
  gate to install. The application's own server is built first, so its gate takes them when it has one;
  `authentication(g => g.oidcRoutes(false))` keeps them off a listener's gate.

- **Lifecycle.** `run()` starts the application's own server first, then each listener, with the listen settings of
  its own `l.server(...)`; what `run(...)` is given does not reach them. `close()` closes the application's own
  server first, so probes and metrics answer through the drain.
- **Clients and tests.** A typed client reaches a listener's routes given its origin, typed by the router the
  listener mounts: `brewer<typeof jobsRouter>(app.listeners.get('admin')!.address!.origin)`. A test sends a request
  with `app.listeners.get('admin')!.request('/jobs')`; `app.request(...)` reaches the application's own server only.
  Each listener is an `IServer`, as the application is for its own server.
- **OpenAPI.** `@caffeinejs/openapi` documents the server it is registered on, so routes a listener serves are
  left out of the main document. A listener gets one of its own with a named plugin,
  `.listener('admin', l => l.with(openapi('admin')))`, served at `/openapi/admin.json` and read from code with
  `container.get(OpenAPIProvider).docs('admin')`. Both need `.install(OpenAPI())` on the application.

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
- A verb ends the chain. Returns a `Response` whose `.json()` is typed — checking `res.ok` is yours. A route that
  answers with text, bytes, a file, a stream or a whole `Response` sends it as it is, so its `.json()` is
  `unknown`: read it with `text()`, `bytes()`, `blob()` or `body`.
- `brewer<typeof app>`, `brewer<typeof someRouter>` and `brewer<RoutesOf<typeof app>>` all work, so a package can
  ship a client for just its own routes.
- The routes are the ones the application declares. An application served under a `.basePath(...)` puts the base
  in the URL — `brewer<App>('https://gateway.example/api')` — which the path is joined onto, never resolved
  against.
- Given the application instead of a URL, requests go through its own `request` and never reach a socket — which is
  how to test one. Both the routes and the transport come from the argument, so neither the type argument nor the
  URL is written. The application must be `bootstrap()` first, or every call rejects with `ErrApplicationNotReady`:

  ```ts
  await app.bootstrap()
  const client = brewer(app)
  await client.pets({ id: 1 }).get()

  brewer<typeof petsRouter>(app) // one router's surface, driven through the application
  ```

  The target is structural — anything with a matching `request` works, a stub included — and `options.fetch` still
  wins over it. Once `close()` has finished, `app.request(...)` rejects with `ErrApplicationClosed`.

- Bodies follow the platform. A declared object goes as JSON, or as a `URLSearchParams`
  form when every field is text, a number, a boolean or a list of those.
  A `FormData`, `URLSearchParams`, `Blob`, string, bytes or `ReadableStream` is sent as it is: a form always under
  the content type the platform writes for it, and a `Blob` that has a type under its own unless the call names
  another. A function that returns a `ReadableStream`, or a promise of one, is called when the request is sent —
  `body: () => file.stream()` — and again for each follow-up an authenticator sends, so a call answered without the
  server opens nothing. It returns a new stream every time.
- Downloads are read with the platform's own readers. `client.$file(res)` turns one into a `File`, named from its
  `Content-Disposition` (the UTF-8 `filename*` first, made a plain file name on any system: never a path, a drive, a
  stream or a device) and typed from `Content-Type`. `client.$filename(res)` names a download streamed from
  `res.body` without reading it. A route answers one with `Attachment(...)` ([Downloads](#downloads)).
- `client.$progress(onProgress)` is a `TransformStream` that counts the bytes going through it: pipe `res.body`
  through it for a download, or send `file.stream().pipeThrough(client.$progress(...))` as an upload. Browsers
  stream an upload only over HTTP/2, and Firefox and Safari not at all.
- The file helpers hang off the client's root, `$`-prefixed like `$request`, so they seldom share a name with a
  route segment. A root segment that does is reached through `$request`.
- `.query({ body })` sends QUERY. A path value of `.` or `..` rejects with `ErrBrewPathValue`, as does a segment its
  values fill as one (`:name.:ext` with two empty values): a URL would resolve it as a step along the path and reach
  another route. A parameter given `undefined` or `null` adds no segment,
  which is how an optional one is left out, so only the types require one: a call they do not check, through a cast
  or plain JavaScript, reaches the parent route instead. `$request` rejects the same call with `ErrBrewPathParam`.
- Interceptors run around every request, on the platform's own `Request` and `Response`. The first listed sees the
  request first and the response last; `next` sends it on, and not calling it answers without the server:

  ```ts
  const client = brewer<App>('https://api.example', {
    interceptors: [
      async (request, next) => {
        request.headers.set('x-request-id', crypto.randomUUID())
        return next(request)
      },
    ],
  })
  ```

  Set a header on `request` itself: `new Request(request, { headers })` replaces every header it had. A body is read
  as it is sent, so an interceptor that sends again, such as a retry, hands `next` a `request.clone()` on every attempt
  but the last. A client with interceptors or an authenticator hands its `fetch` one `Request`, and an aborted call
  rejects at once with the signal's reason, whatever an interceptor still waits on.

- An authenticator answers a 401. Handed a copy of the request that got it, the 401 and the attempt, it returns the
  request to send in its place, or `null` to let the call resolve with the 401. It runs around the interceptors, so
  the follow-up goes through them again, and the copy is rebuilt from the call's own body, so nothing is held in
  memory for it. A call sends at most `maxFollowUps` follow-ups, 3 unless set, then rejects with
  `ErrBrewTooManyFollowUps`:

  ```ts
  const client = brewer<App>('https://api.example', {
    headers: () => ({ authorization: `Bearer ${tokens.access}` }),
    authenticator: async (request, _response, attempt) => {
      if (attempt > 1) {
        return null // a token just refreshed and still refused will not do better
      }
      // Every call refused at once comes here: refresh once, and only for the token the call carried.
      if (request.headers.get('authorization') === `Bearer ${tokens.access}`) {
        await tokens.refreshOnce()
      }
      request.headers.set('authorization', `Bearer ${tokens.access}`)
      return request
    },
  })
  ```

  Keep a credential the authenticator compares in `headers`, which a follow-up does not resolve again: it never sees
  what an interceptor set. It answers the call's own server only: a 401 that `fetch` reached by a redirect to another
  origin goes to the caller, and a follow-up to another origin rejects with `ErrBrewFollowUpNotSent`. On a redirect to
  another origin, `fetch` drops `Authorization` but forwards every other header, so carry the credential in
  `Authorization`, or send with `redirect: 'error'`, to keep it from a server yours redirects to. A stream passed
  as the body is read as it is sent, so its follow-up rejects with the same error; given as `body: () => file.stream()`,
  it is opened anew for each send. An aborted call rejects at once, even while the refresh it waits on goes on.

- Zero runtime dependencies and browser-safe. The front-end needs `@caffeinejs/http` as a **devDependency** only to
  resolve the `App` type — `import type` is erased, so nothing ships.
- Escape hatch for a path built at run time, a segment named after a verb or `then` (or `$request`, at the root), a
  segment holding more than one parameter or text beside one (`/near/:lat-:lng`, `/files/:name.json`), or a method
  with no verb: `client.$request('GET', '/pets/:id', { params: { id: 1 } })`. A trailing `?` makes a segment
  optional only when the segment starts with its parameter and has no constraint (`:id?`, `:lat-:lng?`), and the
  parameters of such a segment are given together or not at all.
- Static: `.with(staticFiles(s => s.serve(root, { prefix: '/static' })))`, after `buildStatic({ root })` from `@caffeinejs/static/build` in the build. That serves the files the build listed. It is not SPA history fallback — for a single-page application see [spa.md](spa.md), which is routing the application writes. A miss under a directory of the mount is a 404, not `index.html`.
