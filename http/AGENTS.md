# `@caffeinejs/http`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- The adapter is Fastify. Handlers throw `ErrHTTPNotFound` and the other `ErrHTTP*`; there is no Nest `HttpException`.

## Layout

- `http/` is the base: the application, the adapter contract, the request context, servers, plugins and
  `decorators/`. `core/<dir>/` holds what runs on any adapter: routing, middleware, errors and every built-in
  feature. `platform/fastify/` holds the Fastify adapter and each directory's Fastify half, at the same path.
- `platform/fastify/` is an entry root like `http/`: neither has a main file named after it.
- Under `platform/fastify/`, no file is named `fastify_*` and no declaration carries `Fastify`: the directory says
  it. A file takes its core twin's name (`context.ts`, `adapter.ts`) and a type the plain name of the `I*`
  interface it implements (`Context`, `ContextRequest`, `AdapterTypes`). Fastify's own types and `fst` keep theirs.
- Nothing outside `platform/` imports `fastify`, `fastify-plugin`, `@fastify/*` or `platform/`, directly or through
  another module; a test may. The `http/**` override in `.oxlintrc.json` refuses the direct imports. Root and core
  may import each other.
- A feature's builder, options, keys and checks live in `core/`, its plugin and hooks in `platform/fastify/`, so
  another adapter re-implements the platform half alone.
- Subpaths drop `core/` and `platform/`: `@caffeinejs/http/cookie`, `@caffeinejs/http/fastify`. The bare entry
  exports the base and every core directory but `bff/`; a Fastify-side name comes from `@caffeinejs/http/fastify`
  alone.
- The error-handling and cookie features bind their settings (`core/error/keys.ts`, `core/cookie/keys.ts`); the
  Fastify adapter builds both head slots from them, on every server it builds.

## BFF

- `core/bff/` comes from `@caffeinejs/http/bff` alone; the bare entry does not re-export it, so `join`, `map` and
  `timeout` stay off it.
- A new behaviour is another function of the `Call<T>` shape. `join` gains no methods, and there is no list of
  plugins for it to interpret.
- The `timeout` timer is deliberately not unref'd: it is what settles a call that ignores the signal.
- `core/bff/` imports nothing from the rest of `http/`; `join` takes `{ readonly signal: AbortSignal }` and a
  handler passes `ctx`.
- There is no partial screen: a required failure rejects `join`.
- Production code never imports `@caffeinejs/resilience`; tests are the place that imports it.

## Plugins

- Hand a `@fastify/*` plugin back with its options, `[plugin, options]`, unwrapped; a wrapper with its own body
  still needs `fp()`.
- `.with(...)` is not generic in that pair; write `satisfies` where the shape matters.
- The adapter installs the form body parser itself, before the plugin loop. Cookies are parsed on first read, so no
  plugin has an order to get right; the gate refuses to start a cookie-based scheme on a server whose cookies are off
  (`ErrAuthenticationCookies`).
- A plugin's per-request setting is a Fastify decoration read off `request.server`, as `@caffeinejs/html` does.
- A factory may return an `HTTPPlugin` (`plugin.ts`), on `.with(...)`, `l.with(...)`, `router.with(...)` or
  `@Use(...)`. The adapter never sees one: a server's register in `ServerSet.setup`, in their slot, before
  `adapter.setup`; a router's and a controller's register in `ScopedPlugins` (`core/routing/programmatic/`), before
  routing is built. `HTTPPluginFactory` stays Fastify-only; the plugin-taking sites widen to `| HTTPPlugin<T>`.
- `context.app` is a `PluginSlot` (`plugin_slot.ts`), open only inside `during(...)`, which closes in `finally`.
  The application-level context carries a closed one (`closedApplicationOps`), so a middleware factory, a server
  callback and a kept context are refused. A controller's slot refuses `mount`.
- A server's slot mounts onto that server: collected through `FluentRouteSource` once the slot closes, so a router
  mounted twice is served once, compiled through `serverCompiler` into that server's groups, out of
  `app.routeGroups`. A collected group whose router chain (its `scopes` keys) matches a group the server already
  serves is skipped (`isServed`, `servers.ts`). Compare per group, never per root router: a router whose nested
  router is bound elsewhere is split across servers. Its middleware joins `definition.middlewares`, after the
  application's own `.use(...)`.
- A router's slot nests what it mounts under the router through `ScopedPlugins`' side map (`childrenOf`), never the
  router state, so one router mounted into two applications starts from what it declared in both. A router's or a
  controller's middleware is resolved once, keyed by its state or class, and installed in each group context after
  that scope's plugins, its relative paths rebased under the group's `RouteGroupScope.path` (`rebaseMiddlewares`,
  `platform/fastify/middleware/middleware.ts`), which refuses a wildcard or an optional parameter in the base.
- A callback-style Fastify plugin body calling a kept `context.app` throws where avvio does not catch; a plugin body
  adds a group with `$route`.

## Cookies

- `http/core/cookie/` is the cookie implementation (`signer.ts`, `options.ts`, `rules.ts`, `serialize.ts`). It
  imports nothing from Fastify, `node:crypto` or `Buffer`: signing is Web Crypto, so `ctx.req.signedCookie()` is
  async. `platform/fastify/cookie/cookie.ts` is the glue, built once per server by the cookie head slot.
- Nothing here reads `request.cookies` or calls `reply.setCookie`/`clearCookie`. Cookies go through `ctx.req.cookie()`
  and `ctx.cookie()`, or `request.httpContext` from a raw hook. An application may register `@fastify/cookie` for an
  ecosystem plugin; the two coexist.
- The writer is the plugin's root `onSend` hook, which runs ahead of every later plugin's and route's `onSend`, so
  caching sees `Set-Cookie`. It merges `set-cookie`, never replaces it, and never writes an empty list.
- A signer, given as an instance or a container key, is resolved once, in the plugin body. A per-call secret is
  handed to that signer; never construct a signer on a request's path.
- Error text never repeats a cookie value: cookie@2's `TypeError`s are mapped without `cause`.
- The authentication schemes write every attribute of their cookies, an unset one as `undefined`, so the server's
  `parseOptions` defaults never reach them; they pin `signed: false`. Their values keep the server's `encode`: every
  read decodes with the server's `decode`, so clearing one without the other breaks sign-in.
- `respond()` (`platform/fastify/error/error.ts`) asks `cookieFlushFailed(reply)` before trusting `ctx.sent`: a send
  that died writing its cookies left `ctx.sent` true with nothing in flight.

## CSRF

- `http/core/csrf/` is cross-origin protection by Fetch Metadata, and nothing else: no token, no cookie, no secret.
  `origin.ts` is the check, pure, and `platform/fastify/csrf/csrf.ts` the only file that knows Fastify; another
  adapter re-implements that file alone.
- `checkOrigin` compares an `Origin` with `ctx.req.host` and `ctx.req.protocol`, so `trustProxy` governs what a
  proxy may say; never read `X-Forwarded-*` directly. `same-site` and `Origin: null` are refused; a request carrying
  neither header passes as non-browser traffic, as Go's `CrossOriginProtection` and ASP.NET Core's
  `CsrfProtectionMiddleware` have it. An `https:` `Origin` naming the host passes on a request seen as `http`, on
  purpose: the reasons are in `origin.ts` and the HTTP docs' limitations. Do not require the schemes to match
  without them.
- The check is one root `onRequest` hook, callback-style, in the `.with(...)` slot it was written in. It skips
  `request.is404`, the safe methods (`SAFE_METHODS`), a route whose config carries `'caffeine:csrf'` with
  `exempt: true` (`csrfExempt()`, `@CSRFExempt()`, `csrfExemptConfig()`), and an unmarked route whose registered
  path is under `.exclude(...)`. A route's own mark wins: `exempt: false` (`csrfExempt(false)`,
  `@CSRFExempt(false)`) keeps it protected under an exempt group or an excluded prefix, since compilation writes a
  route's config over its group's. Read a mark with `csrfMarkOf`, never as a boolean: `false` is a mark, not its
  absence. Exclusion is judged by `request.routeOptions.url`, never the URL requested, and `exclude('/')` is refused.
- A refusal is `ErrCSRFCrossOrigin`, an `ErrHTTPForbidden` with its own code, handed to `done(err)`. Its message
  never repeats a header value; the warn log carries `reason`, the method, the path without its query and the
  headers that decided it. `enabled(false)` registers no hook and warns once as the server starts.
- `normalizeTrustedOrigin` refuses what is not exactly `scheme://host[:port]`. The WHATWG parser takes `*` for a
  host character, so a wildcard is refused by name.
- A request's `Origin` is read as an `http:` or `https:` origin, or not at all (`parseOrigin`). The parser gives `ws:`
  and `ftp:` URLs a host and a `blob:` URL its inner origin, none of which a page sends: each is `origin-malformed`.
- The application's checks, `trustOrigin(...)` and `allowSecFetchSite(...)`, only widen. They are asked on the deny
  path alone, about what `checkOrigin` puts in `askable`: an `http:` or `https:` origin that is not a downgrade, and
  the site when it is `same-site` or `cross-site`. `origin.ts` alone decides what is askable; `Origin: null`, a
  malformed origin and a downgrade never are.
- Each check is handed `request.httpContext` and, for `trustOrigin`, a fresh `URL` per call. Only a literal `true`,
  or a promise of it, lets the request through. A throw or a rejection reaches `done` wrapped in an `Error`, as the
  guards do: Fastify reads a falsy `done(err)` as "continue", which would skip every later hook. Calls accumulate,
  origin checks before site checks, in the order written. Checks are code only, never in `CSRFConfig` or the
  schema.

## Authentication

- Before a security review of `security/`, read [`security/SECURITY-REVIEW.md`](security/SECURITY-REVIEW.md). Use
  the `security-audit` skill for vulnerabilities and `sharp-edges` for API and option design.
- `assertAuthenticationConfigured` refuses a protected route with no scheme configured, not the gate.
- `assertRoutesGated`, from the adapter's first `onReady` hook, refuses a route a gate would authorize that no gate
  covers. Covered means registered in the context a gate installed on or one beneath it (gates record themselves in
  `AuthenticationGates`), and not owned by another gate. Never judge coverage by `gateOwner` alone: a gate's
  request hook reaches children created before it, while its stamp reaches only routes registered after it.
- `skipAuthentication` (`authenticationExempt()`, `exemptFromAuthentication(route)`) skips authenticating, so
  `request.user` stays `null`; `auth.allowAnonymous` still authenticates and skips only authorization. Do not
  merge them.
- `$caffeine` is optional (a 404 has none); `$caffeine.compiled`, never `$caffeine` itself, tells a compiled
  route from a raw one; `$caffeine.auth` is a raw route's policy slot, with no helper yet.
- `isNavigation` (`navigation.ts`) alone reads `Sec-Fetch-Mode`, `Sec-Fetch-Dest` and `Accept` for that question, so
  `shouldRedirectChallenge` and `@caffeinejs/static`'s `isDocumentRequest` agree. `core/csrf/origin.ts` alone
  reads `Sec-Fetch-Site` and `Origin`.
- Several schemes on one route each append `WWW-Authenticate` with `ctx.appendHeader`, never `ctx.header`.
- A catch-all is the application's: `GET /*` on its own router, marked `detail('http', { internal: true })`,
  throwing `ErrHTTPNotFound` ([`../ai/docs/spa.md`](../ai/docs/spa.md)).
- `ctx.auth` holds per-request authentication state; do not park it on the singleton keyed by the context.
  `AuthenticationService` is its only writer.

## Adapter and types

- The `healthProbes()` plugin resolves `ApplicationHealth` before checking `enabled`, since building it rejects a
  non-singleton indicator; nothing invalidates the cache at shutdown. The budgets are the `Health()` feature's.
- `ErrShutdownTimeout` lives in `@caffeinejs/application/shutdown`, not `core/error/common.ts`.
- No second adapter type for TLS or HTTP/2: TLS is switched by configuration at `bootstrap()`.
- `protocolOf(request)` (`platform/fastify/protocol.ts`) is the only reader of Fastify's `request.protocol`, which
  carries a trusted proxy's `X-Forwarded-Proto` as written (`HTTPS`) and is `undefined` without a socket; it answers
  lower-case, `''` when unknown. `ctx.req.protocol`, the cookie writer, the CSRF check and the middleware bridge all
  call it, and need no request context to do so.
- The adapter applies the base path in `rewriteUrl`; never prefix at registration or rewrite `url` in `onRoute`.
  Only `ctx.redirect(...)`, `AuthenticationProperties.redirectURI` and the `returnTo` query resolve `~/`
  (`resolveAppURL`); nothing else is rewritten.
- `req.signal` is read on timed routes only; elsewhere the read would create a controller per request
  (`_tests/handler_timeout.test.ts`).
- `ctx.sent` is asked before every send on somebody else's behalf, and by the route handler before every branch,
  not only `undefined` (`_tests/handler_answered.test.ts`).
- A newly found server-library type becomes a member of `IAdapterTypes` (`adapter.ts`), never another type
  parameter.
- A core interface that an adapter implements or extends is named `I` plus its full, unabbreviated name
  (`IContext`, `IRequest`, `IRouteGroup`, `IAdapterTypes`), leaving the plain name to the adapter's own type. No
  other interface takes the prefix.
- No server decoration holds the route table; a plugin needing routes adds an `onRoute` hook
  (`collectRouteGroups(instance)`), not a scan in the adapter.
- `$route` is fire-once, not get-or-create, and open only while the server's root loop installs: the `.with(...)`
  plugins, or a listener's. A later call is recorded and thrown from `onReady`: avvio does not catch a
  callback-style plugin's throw. It adds the group to the server whose plugin calls it, and refuses a group bound to
  another server. A plugin that needs nothing from the instance mounts from its factory or an `HTTPPlugin` instead,
  whose method is `register`.

## Servers

- The adapter is a server factory. Every `setup(input)` builds one independent `IAdapterServer`, sharing only the
  request context binding and the parameter compilers.
- `IServer` (`server.ts`) is a server as its callers see it: `instance`, `address` and `fetch`, never a lifecycle
  member, and no `name`: `Application.name` is the application's, and a listener's name is its key in
  `app.listeners`. `WebApplication` implements it for its own server; `IAdapterServer` extends it with `run`,
  `teardown` and `forceTeardown`. `app.listeners` hands out a view per listener (`core/listener/servers.ts`) delegating
  to its `IAdapterServer`, never the server cast to `IServer`, so only `ServerSet` runs or tears one down.
- Every server, the application's own included, is a `ServerDefinition` (`server_definition.ts`) built by one path,
  `ServerSet` (`servers.ts`), through `setup(input)`. `WebApplication` fills its own; `Listener(...)` binds one
  per name. Nothing in that path is listener-specific: a server differs only by its name, which routers bind to.
- The application's own server listens first, since Watt takes over the first listen to complete. It also closes
  first, so listeners answer through the drain.
- Which server serves a router is decided once, in `buildRouting`, from its labels. A source declares groups; it
  never filters or compiles them.
- Labels merge outer-first. The flatten walk refuses a nested router bound to a server other than its parent's,
  and a router nested in itself, by `.mount(...)` or by a router plugin's `context.app.mount(...)`: it checks the
  routers on the current path only, so the same router under two parents stays served in each place.
- `IRouteGroup.boundTo` is metadata, stamped from the labels. Nothing routes by it.
- A router binds through `binding.ts`, with `bindTo` or `@BindTo`. A plugin or a middleware reaches a listener
  only through its own `l.with(...)`, `l.use(...)` or `l.useFn(...)`. Only `WebApplication` and the package
  barrel import `core/listener/`.
- Each server's `GlobalErrorHandlerRef` is its own: the adapter builds one per server, hands it to the error-handling
  plugin it installs first, and reads it right after that server's root loop.
- A listener has no gate unless its own `l.with(...)` registers one; a gate covers only the server it was
  registered on. `OIDCRoutesRef.claimed` is shared, so the OIDC routes go to the first gate to install, and the
  application's own server is built first.
- No server declares authorization of its own. A route requires what its router or controller declares, and an
  undeclared or raw one answers to the fallback policy, on every server alike.

## Routes

- Nothing in `core/routing/` imports `platform/`: registering a compiled group with Fastify is
  `platform/fastify/routing/`'s. Do not reintroduce `Router` as the compiled shape (`IRouteGroup`).
- Keep the verb overloads' order (schema before handler) and the `.inject()` spec overload first; inference
  depends on it. The inline forms call `RouteChain`; do not give them an options argument.
- Write a route-level feature as a `RouteExtension` (`core/routing/extension.ts`); the decorator calls it, and a router
  or a route chain applies it with `.extend(...)`. `.with(...)` on a router registers plugins.
  `flatten.ts` overwrites `path`, `method`, `parameters` and the handler, so an extension leaves them alone.
- `addRouteHook` replaces a hook slot's array and never mutates it, since Fastify shares it with a GET route's
  HEAD twin; a `RouteExtension` writing plain route config comes first.
- Both raw-body parsers are handed the route's `bodyLimit`, but Fastify enforces a limit only on a body it reads itself.
  `bodyAsBuffer()` reads through `parseAs: 'buffer'`, so Fastify holds it to the limit; `bodyAsStream()` holds its
  stream to `request.routeOptions.bodyLimit` itself (`limited()` in `platform/fastify/routing/routing.ts`). A new
  parser reading the payload stream must do the same, and must not `pipeline` it: that destroys the request, and its
  socket, before the 413 is sent.
- `fst({ … })` (`platform/fastify/routing/route_options.ts`) is the only Fastify escape hatch on a route. Do not widen
  it: its type omits what the adapter writes, `config` included.
- `compile.ts` knows nothing about constraints; `constraint()`/`@Constraint` write `route.config` under
  `kRouteConstraints` for the `constraints()` plugin to resolve. `appendVary` (`vary.ts`) is the one writer of
  `Vary`. No version argument on the inline verb form, no `enableVersioning()`, no `VERSION_NEUTRAL` catch-all,
  no global default version.
- Route types accumulate on the return value of `.handler()`; the variable staying `never` is not a bug. Mount
  dedupe is sibling-scoped by `RouterState` identity; never dedupe globally.
- A programmatic handler is `(ctx, deps)`; its dependency bag is built once, never per request.
- `@Catch` dispatches by class on a matched route:
  - Thrown `ErrHTTPNotFound` → `@Catch` / default `ErrHTTP` JSON body
  - No route matched → Fastify not-found. Does **not** go through `@Catch`
  - `ctx.notFound(body)` sets 404 on a request that **already matched**
  - Do not return SPA `index.html` from `@Catch(ErrHTTPNotFound)`

## Per-request values

| The value is…                                             | Goes to                                     | Read with                   |
| --------------------------------------------------------- | ------------------------------------------- | --------------------------- |
| an injectable service with a lifecycle                    | a request-scoped binding (`Scopes.REQUEST`) | `container.get` / injection |
| a plain value one middleware computes and a handler reads | `ctx.state`                                 | `ctx.state.get(key)`        |
| the authenticated principal                               | `ctx.user`                                  | `ctx.user`                  |
| what each authentication scheme decided                   | `ctx.auth`                                  | `ctx.auth?.find(scheme)`    |
| what the route declared                                   | the route config                            | `ctx.routeConfig`           |
| the application configuration                             | a snapshot on the context                   | `ctx.config`                |

- Only the adapter builds a request context: `Context` once per request in `platform/fastify/adapter.ts`,
  stored as `request.httpContext`, and `ContextRequest` lazily by its `req` getter. Code holding a raw
  `FastifyRequest` reads `request.httpContext` (or `request.httpContext.req`); never construct either anywhere else, or
  two contexts disagree on the same request.
- `ctx.state` is application space; a first-party value gets a dedicated member, as `ctx.user`, or the route
  config.
- Do not add a Fastify-named member to `IContext` or cast one to `Context`; `ctx.platform` is the escape
  hatch.
- Do not invent a second "stream scope"; fix how the adapter awaits the request.
- `payloadOf` (`platform/fastify/response.ts`) is the one place an answer becomes what Fastify sends: a handler's, a
  `Responder`'s, a catch handler's, `ctx.body(...)`'s and an `ErrHTTP`'s body. A new send site calls it; never hand
  Fastify a raw answer, which sends a `Blob` or an `ArrayBuffer` as `{}`. A `Blob` is streamed under its size, a
  stream labelled `application/octet-stream`, and a returned `Response` taken apart there, its status and headers on
  the reply before the `onSend` hooks and its body streamed, so `return new Response(stream)` works and `HEAD` answers
  it. A route that streams needs no `ctx.platform.reply.hijack()`, which skips the `onSend` hooks and so cookies,
  caching and compression.
- `Responder` is unwrapped once. `@Produces` only sets `Content-Type`, and the reply's type wins over a `Blob`'s own.
- `unwrap` (`response.ts`) never copies a hop-by-hop header, or one a `Connection` value names. A `Response` of type
  `basic` or `cors` whose every coding `fetch` decodes (`DECODED_BY_FETCH`: `zstd` only where undici and zlib both
  decode it) loses `Content-Encoding` and `Content-Length` too; a `default` one, built in a handler, keeps both.
- An error helper's status and an `ErrHTTP`'s stand over a `Response` given as the body (`keepStatus`); a handler's,
  a catch handler's and `ctx.body(...)`'s `Response` sets the status.
- `ctx.body(...)` and the error helpers refuse a thenable with `ErrConfiguration` before anything is written, so the
  context stays unanswered and the handler can still answer.
- `Attachment` answers its preconditions before ranges, in RFC 9110 §13.2.2's order, on a `GET` or `HEAD` still at
  `200` alone, and closes a stream its `412` or `304` leaves unread. A failed `If-Match` or `If-Unmodified-Since` is
  thrown as `ErrHTTPPreconditionFailed`, never sent in place, so `@Catch` sees it. `If-Match` and `If-Range` compare
  strongly, `If-None-Match` weakly (`_conditional.ts`); never swap them. A date is read as an HTTP-date or not at all
  (`httpDate`), never with `Date.parse`, which takes `2026` for one. A name is reduced to its last
  segment in `_disposition.ts`, for `name` and a `File`'s own alike.
- Several ranges are one `multipart/byteranges` body (`_range.ts`), each part typed by `partType`:
  `ctx.getHeader('content-type')` when it passes `FIELD_VALUE`, the set Node writes as a header value, else the
  `Blob`'s type. A type is never written into a part unchecked: a line break there adds lines of its own. A body the
  reply gives a `Content-Encoding` is never multipart. More than 100 ranges, or ranges adding up to more than the body,
  are sent whole, and the limits apply before anything is sliced. A `Blob`'s parts are slices of it, never copies
  (`_tests/memory/large_downloads.test.ts`).
- Node's `Blob.slice` aborts the process on an offset past 2^32 - 1: nothing slices a larger `Blob`, and `Attachment`
  sends one whole. `fs.openAsBlob` reports a file past 4 GiB at its size modulo 2^32.
