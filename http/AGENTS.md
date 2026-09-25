# `@caffeinejs/http`

Adapter is Fastify. Controllers are `@Controller` + `@Get` / `@Post` / … + `@Args` / `$p`. Throw `ErrHTTPNotFound` (and other `ErrHTTP*`) from handlers. Do not invent Nest `HttpException`.

## The built-ins are plugins

There is no `Services` record, no `Contributions`, no `ServerExtension`, no `registerPlugin` and no
`kit.extensions`. Everything this package wires at start-up — the error handler, the form body parser, the health
probes, the OIDC callback routes, the authentication gate, the not-found handler — is an ordinary Fastify plugin.
A feature registers its own from its server hook (`HTTPFeature`, `[kFeatureServer]`; `HTTPFeatureBuilder.server`),
which the adapter runs as one `fastify-plugin`-wrapped plugin in the feature's slot, so `instance` is the root
server. `adapter.setup()` has one registration loop over factories' plugins and features' hooks alike.

Wrap a plugin in `fastify-plugin` and its hooks and decorations apply to the context it was registered in;
leave it unwrapped and they stay inside the plugin, covering only what the plugin itself registered. The
plugin does not pick that context — the application registers it on the root server, and `router.plugin(...)`
/ `@Use(...)` register it inside one route group's context. Every first-party plugin here is wrapped.

So is every official `@fastify/*` plugin, by its own author — which is the half of the rule that catches people
out. `@fastify/cors`, `@fastify/helmet` and the rest are already `fastify-plugin`-wrapped, so registering one
**directly** puts its hooks on every route and needs nothing added. A wrapper an application writes around one
is not wrapped, and the wrapped plugin inside it hoists only as far as that wrapper's own context — a sibling of
every route group, so its hooks reach nothing at all. That is why a factory hands a plugin back **with** its
options rather than closing over them in a wrapper, and why a wrapper that does have a body of its own — one
registering a plugin _and_ adding a hook — still needs its `fp()`.

`.with(...)` takes either a feature or a plugin factory `({ config, container, logger }) => <plugin>` — never a
bare plugin, so `.with(() => myPlugin)` is how a plugin needing no configuration is written. The factory's one
argument is `HTTPSetupContext`, the same object a feature's server hook and a middleware factory get — the hook
declares that type, so the container it is handed resolves. Both shapes
land in the same list, so they register in the order the calls were written. A feature is installed once per name. A
plugin factory is never deduplicated, so two calls register two plugins; a `fastify-plugin` name already
registered on that Fastify instance is refused with `ERR_HTTP_DUPLICATE_PLUGIN` rather than hanging inside a
re-declared decorator — and registering a plugin rather than a wrapper is what makes that check read the
plugin's own name.

A plugin taking options is handed back **with** them — `({ config }) => [myPlugin, { ...config.app.thing }]` —
and the adapter registers the pair. They are built inside the factory, so they can come from configuration or
from the container, and a plugin whose options are _required_, such as `@fastify/static` and its `root`, is only
registrable this way. The pair is told apart by nothing but `Array.isArray`: a Fastify plugin is a function,
never an array. The options are not type-checked against the plugin — `.with(...)` is not generic in them, and
making it so would decide the application's configuration type from the wrong argument — so write `satisfies`
where the exact shape matters. `router.plugin(...)` and `@Use(...)` take the pair too: all three read the one
`extension` member of the adapter's types.

Order is install order and nothing else: no bands, no `kExtensionStage`, no sort. `WebApplication.configurers()`
holds the only framework slot — `ErrorHandlingBuilder` leads — and everything after it, this package's
features and the user's alike, runs in `.with(...)` call order. The adapter installs two things around that
loop: the form body parser before it, and the default not-found handler after it. Do not reintroduce a stage,
and do not add a third direct `install*()` call: anything a feature can own belongs in a feature, in the right
place. Do not move server wiring back into `bootstrap`: bootstrap hooks run concurrently, before the adapter has
decorated the server.

Cookies are parsed for every request, ahead of every plugin. `CookieBuilder` (`cookie/cookie.ts`) is an ordinary
`HTTPFeatureBuilder` that `WebApplication` registers unconditionally in its constructor, which is what puts it
first in the install list — only the error handler precedes it, and it reads no cookies. So an application
neither registers `@fastify/cookie` nor orders it, and the authentication gate carries no cookie check: a scheme
reading its credential from a cookie can no longer be registered ahead of the parsing. An application states the
plugin's options with `.cookie(...)`, wherever in the chain it likes — a `secret` is the one that matters, since
`ctx.req.signedCookie()` has nothing to verify with otherwise. The two ways out of the registration: a server whose
`.serverCallback(...)` registered the plugin itself keeps its own (the feature stands down rather than
failing on the duplicate decorators, and that application owns its cookie settings entirely), and
`.cookie(k => k.enabled(false))`, which leaves the plugin unregistered so `ctx.req.cookie()` fails rather than
answering `undefined`.

The authentication gate has **no** slot. It is contributed by `AuthenticationBuilder`, so it registers where
`.authentication(...)` was written: a CORS plugin registered before it still stamps its headers on a 401, and a hook
registered after it does not run for a request the gate rejected. The start-up refusal of an application that
protects a route and never configured authentication is not the gate's — it is a scan of the compiled route
groups in the adapter (`assertAuthenticationConfigured`), because the case being refused is the one where no
gate exists.

The gate runs for every request, a route registered straight on Fastify included: a root `onRequest` hook reaches
root routes whatever order they registered in, so install order exempts nothing. It reads one thing,
`config.$caffeine`, because the adapter stamps one onto **every route its server registers** — an `onRoute` hook
added before anything else can declare a route, filling in `{ skipAuthentication: false }` where a route brought
nothing. A compiled route carries what it declared on `$caffeine.auth`; a route that declared nothing carries no
`auth`, and that absence is what the application's `fallbackPolicy` answers, since such a route has no
`@Authorize` anyone could have forgotten. Out of its reach: the path prefixes listed in
`fallbackPolicy(policy, { except })`, a URL nothing matched, and `$caffeine.skipAuthentication`.

`skipAuthentication` makes the gate return before authenticating at all, so `request.user` stays `null` on such a
route. `authenticationExempt()` is how a caller registering its own route sets it, and
`exemptFromAuthentication(route)` how a plugin that only gets an `onRoute` hook does. The health probes and the
OAuth callback and sign-in routes use the first, `@caffeinejs/static` the second, for a mount the application
declared `{ anonymous: true }`. A first-party plugin whose route must answer before anyone is signed in sets it
too.

`skipAuthentication` is **not** `auth.allowAnonymous`, and the two must not be merged. `allowAnonymous: true`
still **authenticates** — it establishes `ctx.user` and only then skips authorization. "Anyone may call this" and
"do not spend work working out who is calling" are different claims, and a liveness probe polled every second, or
the dozens of assets a page pulls, want the second.

`$caffeine` is an invariant of route **registration**, not of every request, and the gate's one `?.` is that
difference. Fastify builds the not-found context directly rather than as a route, so no `onRoute` hook reaches it
and an unmatched URL carries no stamp. That falls to the fallback, whose own `request.is404` check excuses it —
excuses it from _authorization_. It is still authenticated, which is what keeps `ctx.user` populated in the
handler answering an unmatched URL, where a single-page application's shell is served. Do not type `$caffeine` as
non-optional on the strength of the word invariant: every 404 would be a `TypeError` in the gate.

Telling a compiled route from a raw one is `$caffeine.compiled`, never `$caffeine` itself — here, in
`health/probes_route.ts`, in `oidc_routes.ts` and in `routing/fastify/route_config.ts`. Both collision guards depend on it:
each adds its `onRoute` hook before registering its own routes, so without the `compiled` check they would trip
their own guard and fail `ready()`. `compiled` holds `route` and `group` as required members, so one nullable
object narrows all of it at once and a partial stamp cannot reach a reader.

That leaves `auth` as the slot for something the gate cannot do yet: give a **raw** route a policy rather than
only exempting it. Nothing first-party writes it from an `onRoute` hook, and nothing should grow a helper for it
until something needs one — files that must be protected by a specific policy are served from compiled routes,
which is what `@caffeinejs/static`'s `serve: false` mount is for.

Whether a request is a browser navigation is one question with one answer, `isNavigation` (`navigation.ts`):
Fetch Metadata when the request carries it, `Accept` naming `text/html` otherwise, `undefined` when it says
neither. A scheme deciding between a redirect and a `401` reads it (`shouldRedirectChallenge`), and so does
`@caffeinejs/static`'s `isDocumentRequest`, which an application's client-route wildcard calls; each defaults
the undecided case its own way. They must agree, or a request is redirected to sign in by one and answered
`404` by the other. Do not read `Sec-Fetch-*` or `Accept` for that purpose anywhere else.

A route naming several schemes is challenged by each in the order named, each **appending** its
`WWW-Authenticate` (`ctx.appendHeader`, never `ctx.header`), until one answers the request itself — a redirect
status or a sent reply.

A catch-all belongs to the **application**, not to a feature. A single-page application writes `GET /*` on a
router of its own, marks it `detail('http', { internal: true })` so `@caffeinejs/openapi` skips it, and throws
`ErrHTTPNotFound` for what it does not answer, so those misses reach `@Catch` like any handler's. It is
authorized like any route because it is one, and the API owns its own misses with
`newRouter('/api').get('/*', …)`. There is no registry of "server-owned paths", no derivation of them, and no
feature that installs a catch-all on the application's behalf — `@caffeinejs/static` serves files and nothing
else. The recipes are [`../ai/docs/spa.md`](../ai/docs/spa.md).

The not-found handler is therefore the adapter's own, or the application's. A plugin that still wants to answer
unmatched URLs itself may call `setNotFoundHandler` and throw `ErrHTTPNotFound` for what it does not answer;
the adapter installs its default only when no handler is set yet, and a second one fails at start-up with
Fastify's own error.

Health (`/livez`, `/readyz`, `/startupz`) is an opt-in `HTTPFeatureBuilder`, `.with(health(...))`, and is **not**
registered by `WebApplication`, which holds no reference to `http/health` at all. What the probes answer from is
not theirs: `ApplicationHealth` from `@caffeinejs/std/health`, which every `Application` binds in `ready()`,
headless included, so a Watt check or any other caller shares one evaluation with the routes. Installing
`health()` does two things. It mounts the routes (default `enabled: true`; `.k8s()` switches that default to the
Kubernetes auto-detection, `KUBERNETES_SERVICE_HOST` present). And it binds `kHealthRegistryOptions`, the budgets
`ApplicationHealth` evaluates with — even when the routes are off. That binding is why it is a feature and not a
plugin factory: only `configure` runs before `container.init()`, and a plugin factory runs after, when something
may already hold the service. Its server hook resolves `ApplicationHealth` before checking `enabled`, because
building the service is what rejects a non-singleton indicator at start-up. There is no cache invalidation at
shutdown: readiness reads availability before it reads the cache, and a Fastify `onClose` hook would run only
after the server stopped answering anyway.

Graceful shutdown — the drain delay, the teardown budget, the signals — is its own feature, `ShutdownBuilder`
from `@caffeinejs/std/shutdown` (`[kFeatureName] === 'shutdown'`), registered unconditionally by both
`createWebApplication()` and headless `createApplication()` and configured with `app.shutdown((s, { config }) => …)`.
It binds the resolved policy under `kShutdownPolicy`; `Application` reads it. Health does not touch shutdown.
`Application` also enforces the budget, over `stop()` and `container.dispose()` together — `WebApplication` only
supplies the two halves (`stop()` tears the adapter down, `forceStop()` cuts its connections), and
`ErrShutdownTimeout` lives in `@caffeinejs/std/shutdown`, not `error/common.ts`.

A built-in's resolved options that other code must read are container bindings, not configuration keys (health
has one, `kHealthRegistryOptions`). There is no `featureConfigKey` and
`ctx.config` is not callable — a package that needs its settings on a request either binds them and resolves
them, or decorates the Fastify instance as `@caffeinejs/html` does.

## The adapter owns the instance

`fastifyAdapterFactory()` takes nothing, and `createWebApplication()` runs on it when no adapter is named. Nobody
hands the framework a Fastify instance: the adapter constructs it inside `setup()`, from what `.server(...)`
returned, once configuration has resolved and the container has initialized. `.server(configure)` and
`.serverCallback(callback)` are the whole surface. `configure` gets the `HTTPSetupContext` a plugin factory gets and
returns `{ factory, listener }` — Fastify's constructor options and its listen options; `callback` is handed that
same context and then the bare instance right after construction, before `$container`, the request decorations, the rest of the hooks, the form
parser and every plugin, so it is where a pre-registered plugin, an `onRoute` hook, a raw route or a not-found
handler goes. One hook precedes it, the adapter's `$caffeine` stamp, because Fastify runs `onRoute` as a route is
declared rather than when it loads — so a raw route written here is stamped, and an `onRoute` hook added here
runs behind the stamp and reads it.
`factory` takes `https` and `http2` too, and the instance is `FastifyInstance` whichever server they build. That
is deliberate: TLS is switched by configuration at `ready()`, long after the application's type was fixed, so no
type parameter could follow it. `https.Server` is an `http.Server` to `@types/node`, so HTTPS is typed exactly
enough. Under HTTP/2 the server and the raw request and reply are Node's HTTP/2 objects behind HTTP/1 types, and
a reader narrows with `instanceof`. Do not add a second adapter type for a TLS or HTTP/2 server. `address.origin`
reads the scheme off the server (`instanceof tls.Server`), not off the options, so a TLS server built by
`serverFactory` reports `https:` too. An HTTP/2 server has no `closeAllConnections()`, so the adapter keeps its
sockets from `'connection'` and `forceTeardown()` destroys them. The graceful path needs nothing, because on Node
24 `server.close()` closes the HTTP/2 sessions itself.
Calls accumulate: sections shallow-merge in call order, callbacks run in call order. The old builder feature
(`ServerBuilder`, `kServerOptions`, `serverConfigSchema`) is gone; an application declares its own `server` block
and hands the node over as the `listener`.

`.basePath(value)` is the one other input the server is built from. The application resolves and normalizes it
(`base_path.ts`) and hands it over as `AdapterIn.basePath`; the adapter adds a `rewriteUrl` that takes it off a
request's path before routing and records it on the raw request for `ctx.req.basePath`, and an application's own
`rewriteUrl` then runs on the path the application sees. With no base path there is no `rewriteUrl` at all. Routing
never sees the base, so nothing registers differently: every route, `app.use(path)`, the fallback policy's
`except` and both collision guards stay relative to the application, and a request without the base is routed as
it came. Only what builds a URL a browser follows puts the base back — per request with `ctx.req.basePath` (the
cookie and remote authentication redirects), or at start-up with the `$basePath` decoration (the OIDC routes,
whose paths come from a `callbackURL` the browser sees, and `@caffeinejs/openapi`'s `servers` and page links).
Do not prefix at registration instead. A `register({ prefix })` around the plugins moves every one of them off the
root server; rewriting `url` in `onRoute` leaves `routeOptions.url` stale and misses the trailing-slash twin
Fastify registers for a `/` route without running `onRoute`. The middleware engine leaves `raw.originalUrl` alone
when it is set, since that is where Fastify saved the full URL.

A URL an application hands over for the browser is sent as written, except that a leading `~/` resolves against
the request's base (`resolveAppURL`). That is `ctx.redirect(...)`, `AuthenticationProperties.redirectURI` and the
`returnTo` query a remote strategy's sign-in route reads, and nothing else: a header, a body and a configured option
are not rewritten. A configured path is written as the application sees it and gets the base in front already, so
one written with `~/` is refused when its scheme builds rather than sent out as a relative URL. `~/` followed by `/`,
`\` or a control character is left alone, since a browser would read the result as protocol-relative. The cookie
scheme's cookies default to `Path=` the request's base, so applications sharing an origin do not share a session
begun under their bases; one begun on a request without the base is written at `/`, since the base follows the
request here as it does in every redirect. A `__Host-` name keeps `/`. The remote strategies' cookies stay at `/` for
the same `__Host-` reason, and the state cookie must reach a callback that may sit outside the base — co-hosted
applications name them apart instead.

The application's configured logger is the server's `loggerInstance`, with request logging off through a
`LogController`, unless `factory.logger` or `factory.loggerInstance` is set — Fastify refuses both together, so a
`logger` named there is passed through untouched, request logging and level included. The instance is built
after the logger feature resolved, so there is no level to re-sync.

`run(listenOptions?)` is typed by the adapter (`AdapterTypes.runArgs`): under Fastify it takes listen options,
merged over `listener` key by key, `run()` winning. With neither, `listen()` is called bare and Fastify's own
default stands (`localhost`, an OS-assigned port); a `listener` naming a `host` but no `port` is refused by Node
at `run()`, so `port: 0` is spelled out for an OS-assigned port. `run()` still resolves to `WebRunInfo`.
`app.instance` and `app.fetch()` throw `ErrApplicationNotReady` (from `@caffeinejs/std`, which `app.health` throws
too) before `ready()`; `app.address` is `undefined` until `run()` bound the socket.

## Handler timeouts

A server's `factory.handlerTimeout` and a route's `.timeout(ms)` are Fastify's `handlerTimeout`: its timer aborts
`request.signal` with `FST_ERR_HANDLER_TIMEOUT` and sends a `503`. Fastify decides whether a handler that resolves
afterwards may still send by `reply.sent`, which is `raw.writableEnded`; an `onSend` hook that awaits — a
compressor — holds the `503` open, so a handler resolving in that window sends a second time, and
`ERR_HTTP_HEADERS_SENT` escapes as an unhandled rejection. A plain Fastify server does the same. The route handler
in `routing/fastify/register.ts` covers this side: on a timed route, a result arriving after the signal was aborted
by the timeout is replaced by the reply itself, which Fastify awaits until the `503` is out
(`_tests/handler_timeout.test.ts`). The mirror side — the timer firing while the handler's own response is held
open by such a hook — is Fastify's to fix. `req.signal` is read on timed routes only: on any other, the read would
create a controller per request.

## A handler that answers for itself

The route handler's default is to send: a handler returning `undefined` gets an empty response, which is what
makes a `@Post('/logout')` that only redirects, or a `@Delete` that only deletes, work at all. A handler that
answered the request itself and then returned — `await auth.signOut(ctx); ctx.redirect('/', 303)` — must not be
answered over, so the handler asks `ctx.sent` first, and in the asynchronous path hands the reply back rather
than `undefined`: Fastify reads `undefined` from a promise as a request to send.

`ctx.sent` is the context's own record that `body`, `redirect` or a status shorthand has sent, falling back to
Fastify's `reply.sent`. Fastify's alone is not enough. It is `raw.writableEnded`, which stays false for as long
as an `onSend` hook that awaits — `@Compress`, `@caffeinejs/caching` storing an entry — holds the first send
open, and a send started in that window is not the logged `FST_ERR_REP_ALREADY_SENT` of a response already out:
it runs the hook chain a second time and writes headers over headers. Both halves are load-bearing, and
`_tests/handler_answered.test.ts` counts the hook's runs to hold them there. A handler reaching past the context
to `ctx.platform.reply.send(...)`, or hijacking, is outside that record and is seen only once the response has
ended.

The same question is asked the same way wherever this package sends on somebody else's behalf: the error
handler's `respond` (`error/plugin.ts`), the authentication gate after a scheme challenged, the OIDC callback
route after a strategy's `onFail` (`security/auth/oidc/oidc_routes.ts`), and the middleware chain before it
runs the next layer (`middleware/_engine.ts`). A handler that answered and then returned a value or a
`Responder` is not sent over either: the route handler asks before every branch, not only the `undefined` one.

## The adapter owns its types

Everything that belongs to the server library behind an adapter is named once, in an `AdapterTypes` descriptor
(`adapter.ts`): the instance, the request, the extension unit `.with(factory)` installs, the hook names
`app.use(..., { hook })` accepts, the raw request, cookie options and `ctx.platform`. `FastifyTypes`
(`fastify_adapter.ts`) is Fastify's. `Adapter<T>`, `WebApplication<T>`, `Router<…, T>` and `Context<V, C, T>` read
their server-specific types off it. A newly found one becomes a member there, never another type parameter.

`adapter.ts` (the contract every adapter implements), `context.ts`, `middleware/pipeline.ts`,
`middleware/middleware.ts` and every `guards/` file but one — `guard.ts`, `compile.ts`, `builder.ts`,
`keys.ts` and the chain runner `_run.ts` — import nothing from `fastify`. Fastify's side lives in
`fastify_*.ts` — the adapter itself is `fastify_adapter.ts` — `routing/fastify/`, `middleware/fastify.ts` and
`guards/fastify.ts`. Guards are attached by
`guards/fastify.ts` alone: it reads `request.httpContext` and hands the chain to `runGuards`, which knows
only `GuardContext`.

`AdapterRegistry` is augmentable and holds every adapter in the compilation; the Fastify entry is declared in
`fastify_adapter.ts`. What is written without knowing its adapter is typed against all of them: `@Use(...)` takes
any registered extension, and `ctx.platform` on a plain `Context` is any registered platform. With a second
entry, every un-narrowed `ctx.platform` read stops compiling until it checks `ctx.platform.name`. That is
intended.

A router is bound to an adapter only through its last type parameter, which defaults to `never`: bound to none,
it mounts anywhere and its `.plugin(...)` takes nothing. `newRouter()` returns one bound to `FastifyRouterTypes`,
which leaves the instance and request types open so it mounts on an application built around its own Fastify
instance.

## Reading the routes from a plugin

Every route the adapter registers carries what Caffeine compiled for it on
`routeOptions.config.$caffeine.compiled`: `route` (the compiled `Route`) and `group` (the `RouteGroup` it was
compiled in), next to the fields the handler reads. There is no server decoration holding the route table.
Compiled routes register after every plugin, so a plugin that needs them adds an `onRoute` hook, as any
Fastify plugin would; `compiled` is absent on a route registered straight on Fastify, which is how the hook
tells the two apart. `$caffeine` itself is on both — the adapter stamps it — so testing that instead sees
every route there is. A per-route check throws from the hook (`app.ready()` rejects with it); a decision that
needs every route waits for `onReady`. `collectRouteGroups(instance)` is that pattern packaged — it regroups
what registered and counts a GET route's automatic HEAD twin once — and the SPA shell and `@caffeinejs/openapi`
use it.

`RouteDetail` and `RouteGroupDetail` are empty and keyed by owner; the one namespace this package owns there
is `http`. `detail('http', { internal: true })` says a route or group is served by the framework or a feature on
the application's behalf and is not part of its API, and a reader describing the application's routes skips
it: `@caffeinejs/openapi` does, next to its own `openapi.hidden`. The SPA shell sets it.

A route-wide hook whose work depends on the routes — the constraint `Vary` header — is added unconditionally
while its plugin registers, because a route takes the hooks in place when it registers. It returns immediately
when `onRoute` found nothing for it to do. Do not move such a scan into the adapter.

## `$route`: adding a protectable route from a plugin

`buildRouting()` runs once, before any `.with(...)`-contributed plugin. A plugin that needs to add its _own_
route — one going through the same guard/authorization/error-handling path an ordinary route does, not a bare
`fastify.get(...)` — is too late for that pass. `instance.$route(name, build)` closes that gap: `build` receives a `RouteGroupBuilder`
(the same builder `decorators/registrar/registrar.ts`'s `registerRouteGroup` hands a route source), and the
group it describes is compiled on the spot — through the identical `RouteGroupCompiler` instance
`buildRouting()` built, threaded through `AdapterIn.compileRouteGroup`, so a guard shared with an ordinary
route resolves through the one cache, not a second one — and appended to the same table
`assertAuthenticationConfigured`'s startup scan and the Fastify registration loop both read. Compiling is what
happens immediately; registering is not. A `$route` group registers with everything else, after every plugin,
so it reaches every plugin's `onRoute` hook whichever order the plugins were installed in. A compile failure —
an unresolvable guard, an ambiguous `@CatchWith` — therefore rejects `ready()` from inside the registration of
the plugin that called `$route`, which is where the cause is. The group is declared by no class, so it carries
no `target`: a guard on one reads no `Symbol.metadata`, and diagnostics name it by the `name` given here.
`@caffeinejs/openapi` is the one consumer: its doc-serving routes must be real, protectable
routes, and it marks their group hidden (`kAPIGroup`) so the document it generates in `onReady` does not
describe them.

One thing `$route` does **not** do, worth knowing before reaching for it: it is fire-once, not
get-or-create — unlike `registerRouteGroup`, which accumulates onto a key, every call adds a fresh entry, so
two calls with a colliding path fail the way any duplicate route does at registration time.

The effective authentication schemes are stamped onto each compiled route (`route.authorization.schemes`)
while routing is built, where the application's default scheme is known. A reader that documents or describes
a route takes them from there; plugins register before any Fastify route exists, so `routeOptions.config` is
not available to them outside an `onRoute` hook.

## Two route sources

Routes come from `RouteSource`s, and there are two: `routing/decorated/` reads the `@Controller` registry, `routing/programmatic/` reads the `Router` chains an application mounted. Both produce `RouteGroupSpec` and go through the same `compileRouteGroup`, so a route is configured, guarded and authorized identically whichever way it was written. Common pieces live at the root of `routing/`; a `_`-prefixed file there is private to that directory, so anything both sources need (`inherit.ts`) is not underscore-prefixed. `spec.ts` is a route as authored, `route.ts` a route as compiled, and `routing/fastify/` turns a compiled group into Fastify routes; outside the barrel, nothing else in `routing/` imports it.

The compiled group the adapter registers is `RouteGroup`, not `Router` — `Router` is the fluent authoring class. Do not reintroduce `Router` as the compiled shape.

## The two spellings of a route

A verb takes `(path)`, `(path, handler)` or `(path, schema, handler)`. Given a handler the route is closed on the spot and the **group** comes back, not the chain — which is what lets the next route chain off it and what keeps the `RouteDef` accumulating. The schema sits _before_ the handler because TypeScript fixes inferences from non-context-sensitive arguments first, so `S` is resolved by the time the handler's `ctx` is contextually typed; after the handler it would not be.

`.inject()` on both `Router` and `RouteChain` takes a spec or a `(i) => spec` callback handed `$i`. The spec overload must stay **first**: a function type gets no implicit index signature, so an arrow fails the `ObjectInjectionSpec` constraint and falls through, while an object literal never reaches the second. `$i` is handed over at run time rather than re-exported. Both forms are merged identically, so anything reading `#state.injection` cannot tell them apart.

The inline forms are implemented by calling `RouteChain` — `chain.handler(fn)`, or `chain.schema(s).handler(fn)`. There is one registration path and there must stay one, so an inline schema cannot compile differently from a `.schema()` one. Do not grow the inline form a further options argument covering `name` / `authorize` / `guards` / `with`: a route needing those is written with the chain, and a second object-shaped surface would drift from it.

## Extending a route from outside http

`RouteExtension` / `RouteGroupExtension` (`routing/extension.ts`) are `(builder) => void` — the _same_ function a decorator hands to `configureRoute`. That is the point: a feature is implemented once as an extension, and the decorator calls it. `@Operation` and `openapi`'s `operation()`, `@Compress` and `compress()`, `@BodyAsStream` and `bodyAsStream()` are each one implementation with two spellings. When adding a route-level feature, write the extension first and make the decorator call it — never the other way round, and never two copies.

## CORS and compression are plugins the application owns, not packages

`@CORS` / `cors()` and `@Compress` / `compress()` / `@Encoding` / `encoding()` are route-config decorators
only — `target.config('cors', …)` / `target.options('compress'/'decompress', …)`. Neither has a runtime
dependency on `@fastify/cors` or `@fastify/compress`, and http does not ship a plugin wrapper for either:
register the third-party plugin yourself, exactly like any other Fastify plugin —

```ts
.with(({ config }) => [fastifyCors, config.app.cors.options])
```

`CorsOptions` and `CompressOptions` are deliberately empty interfaces: this package has no dependency on
either third-party plugin, so a decorated call (`cors({ origin: '*' })`) type-checks against any object with
no cast. A consumer who has the real plugin installed and wants its exact options shape checked augments the
interface themselves — `declare module '@caffeinejs/http' { interface CorsOptions extends
import('@fastify/cors').FastifyCorsOptions {} }` — there is nothing to opt into on this package's side.

Applied with `.with(ext, ...rest)` on `Router` and `RouteChain`. An extension may write anything on the builder except `path`, `method`, `parameters` and the handler — `flatten.ts` overwrites those.

A feature that must attach a real Fastify hook to the routes it applies to — resolved from the container, not closed over at decorator time — does it from Fastify's own `onRoute` hook inside its plugin: resolve the dependencies once as the plugin registers, then call `addRouteHook` per route. `@caffeinejs/caching` is the one consumer, and the adapter's only cache-specific line is the start-up refusal of `@CacheControl` with no caching plugin serving the route's group — on the root server, or among the plugins the group's own scopes installed. `addRouteHook` replaces an array in a hook slot and never mutates it: Fastify shares that array with a GET route's HEAD twin, and a group-level `fst({ onSend: [...] })` shares it across the group. The hook fires while each route registers, which is after the adapter attached its own — `@UseGuards` included — so what it adds runs behind them. Do not reach for this for anything a `RouteExtension` writing plain route config can express.

## Installing a plugin on one group

`router.plugin(factory)` and `@Use(factory)` register a Fastify plugin inside that route group's context instead of on the root server. Only a router bound to an adapter has `.plugin(...)` to call with a plugin: `newRouter()` rather than `new Router()`. A router takes **only** plugins: scoping was always about where the plugin registers, and a router installs no feature, declares no configuration and is never deduplicated — two routers wanting different settings pass two factories.

The factories are resolved in `WebApplication.setup()`, where configuration has resolved and the container has initialized, so one sees exactly what a factory passed to the application's `.with(...)` sees. `RouteGroup.scopes` carries what registered the plugins for a group — a programmatic group lists its own router and every router it is nested under, so `router.plugin(...)` inherits downward the way `.with(ext, ...)` does; a controller group lists the class.

The factory's context is **not** re-typed against the application's configuration the way `builder.with` is: a router or a controller is written without knowing which application it will end up in, so its `config` is `LiveConfig<unknown>`. A router's binding is checked when it is mounted. A controller's `@Use(...)` never meets the application's type, so the adapter checks what it returned at start-up (`ERR_HTTP_INVALID_PLUGIN`).

`fst({ … })` (`http/routing/fastify/route_options.ts`) is the Fastify escape hatch, and the only one: there is deliberately no generic `routeOptions(key, value)` on the chain. Its type omits `method`/`url`/`handler`/`schema`/`config`/`bodyLimit`/`handlerTimeout` because the adapter writes those itself — `config` especially, which carries `config.$caffeine` and would break status, headers and per-route auth if clobbered. Do not widen it.

## Route-selection constraints and API versions

Version is a **routing key**, not a runtime `switch`: two handlers for the same method and URL are selected during matching, so it is a Fastify route constraint (`constraints/`). There is no dedicated compiled field and no registry — `constraint()` / `@Constraint` write straight into `route.config` (the same object any Fastify plugin reads off `routeOptions.config`), and the `constraints()` plugin is what turns that into something find-my-way actually matches on. There is one mechanism with two spellings and one sugar:

- `@Constraint(name, value, { header })` / `constraint(name, value, { header })` — a first-class constraint, applied with `.with(constraint(...))` on `Router`/`RouteChain` (there is no fluent `.constraint()`). Writes `{ value, header }` into `route.config` under `kRouteConstraints`, so group→route inheritance is the ordinary `config` merge `compile.ts` already does for every other key — `compile.ts` itself knows nothing about constraints. The `constraints()` plugin's `onRoute` hook resolves it into Fastify's real `constraints` matching object when the route registers; an unregistered strategy name fails there with find-my-way's own error, not a Caffeine one.
- `@Version(v)` / `version(v)` — sugar for the `version` constraint, hardcoding `Accept-Version` as its header. `version` needs no strategy: it's Fastify's built-in semver matcher. It is **not** a path — `@Prefix('/v1')` is URI versioning and stays a separate concern.
- `.with(() => constraints([strategy]))` — the one plugin behind all of it: registers custom find-my-way constraint strategies (synchronous only), resolves every route's declared constraints, and sets `Vary`. `.with(() => constraints())` when only `version` is used — `version` needs no strategy, but it does need the plugin. Opt-in, exactly like wiring in CORS or Compress; no `app.constraints(...)`. A route declaring a constraint with the plugin missing fails at start-up (`ErrConfiguration`, a scan in the adapter next to the `@CacheControl` one) rather than matching every request.

Group constraints inherit to routes that do not set the same key — for free, via the generic `config` merge (route wins, same as any other `config`/`options` key), not a dedicated mechanism. `fst({ constraints: { … } })` still works for `host` and anything the framework has no opinion about; a `constraints` key set **both** through `fst` and first-class fails when the route registers, in the `constraints()` plugin, rather than disagreeing silently. The plugin adds every constraint header to `Vary` when any route is constrained, through `appendVary` (`vary.ts`) — the one writer of `Vary`, which merges into what is there and assigns only `*`, which covers it; `@caffeinejs/caching` uses it too. A constraint miss is Fastify's 404 — it does not reach `@Catch`, and no default version is invented. A route registered straight on Fastify (probes, OIDC callbacks) never carries a constraint.

Do not add a version argument to the inline verb form, an app-level `enableVersioning()` switch, a `VERSION_NEUTRAL` catch-all, or a global default version.

## Route-type accumulation

`Router<GD, GP, R>`'s third parameter accumulates a `RouteDef` union, read back with `RoutesOf<T>` through a `__routes` phantom on both `Router` and `WebApplication`. `@caffeinejs/brewer` is the client built on it: it reads `__routes` structurally, without importing this package, so the flat union is its contract now. The paths are the ones the application declares. A `.basePath(...)` is where the application is deployed, not what it declares — a callback can decide it at `ready()` — so it is not in the type; it belongs in the client's base URL, as it belongs in an OpenAPI document's `servers`.

The carrier is the **return value**, not the variable: `.handler()` gives back the router re-typed with the route just closed, so a chain accumulates. Statement style leaves one handle per statement, each naming the same router with one route in its type; `blend(...)` (or `mount(...)`, or `app.mount(...)`) unions them. The variable the routes were opened from stays `never`, and the verb methods cannot mutate a shared type — do not try to "fix" either.

Mounting collapses repeats by `RouterState` identity, which is what makes `mount(pets, list, add)` work when all three are the same object. Dedupe is **sibling-scoped only** — the roots list in `FluentRouteSource`, one parent's `children` in `Router.mount`. Never dedupe globally: `a.mount(shared)` and `b.mount(shared)` push the identical state under different paths and both must register. `mount(path, router)` clones the state, so a prefixed mount is never deduped against an unprefixed one.

A programmatic handler is `(ctx, deps)`. Both arguments are pickers (`$p.context()` and `$p.just(bag)`), so it compiles to the adapter's arity-specialized handler like any decorated one — there is no separate dispatch for it, and there should not be. The dependency bag comes from `container.resolver($i.object(spec))` and is built **once**: its fields are getters that resolve through the binding on access, which is what keeps a single cached bag correct for singleton, transient and request-scoped alike. Do not add per-request resolution on top of it.

## `@Catch` vs unmatched URL

`@Catch` is exception dispatch by **class**, not by URL path. It only sees errors thrown from a handler that already matched.

- Thrown `ErrHTTPNotFound` → `@Catch` / default `ErrHTTP` JSON body
- No route matched → Fastify not-found. Does **not** go through `@Catch`
- `ctx.notFound(body)` sets 404 on a request that **already matched**
- Do not return SPA `index.html` from `@Catch(ErrHTTPNotFound)`

`@Catch` declares the error types a handler renders; it does not put it to work. A handler class reaches the
whole application only when the application enrols it — `.errorHandling(e => e.globalHandlers(H))` — and one
nobody enrols stays bound in the container, reachable through `@CatchWith` on a controller or route, or through
a `@Catch` method on the controller. There is no `{ global: false }`: not enrolling is what that meant. Two
**enrolled** handlers for the same error class fail at boot; two merely declared ones are fine, which is what
lets one module hold both an application-wide handler and a `@CatchWith` one for the same type.

`ErrorHandlingBuilder` is registered unconditionally and leads the install list whether or not
`.errorHandling(...)` is ever called, so an application that never calls it still renders a thrown `ErrHTTP` as
the default JSON envelope.

## Per-request values

Where a value goes depends on who reads it and how long it lives:

| The value is…                                             | Goes to                                     | Read with                    |
| --------------------------------------------------------- | ------------------------------------------- | ---------------------------- |
| an injectable service with a lifecycle                    | a request-scoped binding (`Scopes.REQUEST`) | `container.get` / injection  |
| a plain value one middleware computes and a handler reads | `ctx.state`                                 | `ctx.state.get(key)`         |
| the authenticated principal                               | `ctx.user`                                  | `ctx.user`                   |
| what each authentication scheme decided                   | `ctx.auth`                                  | `ctx.auth?.find(scheme)`     |
| what the route declared                                   | the route config                            | `ctx.routeConfig`            |
| the application configuration                             | a snapshot on the context                   | `ctx.config`                 |
| another feature's own configuration                       | a container binding that feature made       | `container.getOptional(key)` |

`ctx.state` is a `Map` on the context, allocated on first touch. It does not participate in DI: no binding, no
destroy callback, no scope. What it may hold is named by the `V` type parameter a router declares with
`.vars<V>()` — written as a call and not `new Router<V>(path)`, because naming one type argument stops the
compiler inferring the rest and would drop the group's path.

`ctx.config` is a snapshot, taken the first time a request reads it and fixed from then on: a reload landing
mid-request is not observed by a request already under way. Its type is named by `.configType<C>()` on the
router — named apart from `.config()`, which writes the adapter's per-route configuration. The values come from
the application's configuration whether or not a router declared the type.

`ctx.config` is **not** callable. A package that needs its own settings on a request cannot read them off the
context — it knows neither `C` nor where the application put the block. It either binds them in `configure`
and resolves them from the container, or decorates the Fastify instance and reads the decoration back off
`ctx.platform.request.server`, which is what `@caffeinejs/html` does and what keeps a plugin registered on one
route group from parameterizing the rest.

`ctx.platform` is the context's one escape hatch to the server library, as `fst({ … })` is a route's, and every
adapter implements it: under Fastify, `{ name: 'fastify', request, reply }`. Code holding a plain `Context` reads it with no cast. Do not add a
Fastify-named member to `Context`, and do not cast a `Context` to `FastifyContext` to reach Fastify.

`ctx.state` is application space. A first-party package does not write to it: a framework value gets a dedicated
member, as authentication does with `ctx.user`, or goes on the route config. One flat key namespace shared by an
application and every package it installs collides.

`ctx.auth` is that dedicated member for the authentication package: one record per scheme, created on first use
and holding the authenticate call and its settled result. It exists because the service and the handlers are
singletons while the data is per request, and because a request authenticates several times by design — the
server hook with the default scheme, a route with the ones it names, a handler asking again. `ctx.user` is the
outcome and is replaced as a route refines it; `ctx.auth` is stable for the request. Do not park per-request
authentication state on the singleton, keyed by the context.

`AuthenticationService` is the only writer. A handler reads the request and returns an `AuthenticateResult`;
anything a later phase needs — the reason a token was rejected, so `challenge()` can name it — travels in that
result and is handed back as the third argument to `challenge`. A handler that writes to `ctx.auth`, or keeps its
own per-request state, is doing the coordinator's job.

`app.use()` registers middleware on the adapter's lifecycle hooks — Fastify's, a `FastifyMiddlewareHook`, default
`onRequest`; it does not wrap the route handler. `MiddlewarePipeline` only resolves what was registered;
`installFastifyMiddlewares` attaches it, validates the hook names, and normalizes paths the way Fastify's router
does. It infers the variables a middleware declares but does not check them against the routers it ends up in
front of — the routers are declared elsewhere. A middleware naming variables no router declares is not an error.

## Request scope

When the container has request-scoped bindings, the adapter starts a scope in Fastify `onRequest`. `RequestScope.run` destroys the scope when its callback’s promise settles, and `done()` returns as soon as Fastify reaches its first await — so the callback stays pending until `reply.raw` emits `close`. That is the one signal that fires for a response that finished, one that errored, and a connection the client dropped, which is what keeps a handler that streams and a body still being piped inside their own scope.

Resolving a request-scoped binding after the scope ended throws `ErrOutOfScope`; it does not quietly mint a new instance. `close` follows `finish` by a tick, so a synchronous `onResponse` hook is still inside the scope and one that awaits first is not.

Do not invent a second “stream scope”; if lifetime is wrong, fix how the adapter awaits the request, not a new scope kind.

## `ActionResult`

The adapter special-cases `Responder` (and promises of it). A Fetch `Response` is listed on `ActionResult` but is **not** unwrapped — it is passed to Fastify `send()`. Do not assume `return new Response(stream)` works. `@Produces` only sets `Content-Type`.
