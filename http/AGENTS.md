# `@caffeinejs/http`

Adapter is Fastify. Controllers are `@Controller` + `@Get` / `@Post` / … + `@Args` / `$p`. Throw `ErrHTTPNotFound` (and other `ErrHTTP*`) from handlers. Do not invent Nest `HttpException`.

## The built-ins are plugins

There is no `Services` record, no `Contributions`, and no `ServerExtension`. Everything this package wires at
start-up — the error handler, the form body parser, the health probes, the OIDC callback routes, the
authentication gate, the not-found handler — is an ordinary Fastify plugin (`HTTPPlugin`) its own feature
hands over with `registerPlugin(kit, plugin)`, and `adapter.setup()` has one registration loop.

Wrap a plugin in `fastify-plugin` and its hooks and decorations apply to the context it was registered in;
leave it unwrapped and they stay inside the plugin, covering only what the plugin itself registered. The
plugin does not pick that context — the application registers it on the root server, and `router.extend(...)`
/ `@Use(...)` register it inside one route group's context. Every first-party plugin here is wrapped.

Order is install order and nothing else: no bands, no `kExtensionStage`, no sort. `WebApplication.configurers()`
holds the only two framework slots — `ErrorHandlingServiceConfigurer` and `HTTPCoreFeature` lead,
`HTTPFallbackFeature` trails — and everything between them, this package's features and the user's alike,
runs in `.extend(...)` order. Do not reintroduce a stage, and do not reintroduce a direct `install*()` call in
the adapter: write the plugin and put its feature in the right place.

The authentication gate has **no** slot. It is contributed by `AuthenticationBuilder`, so it registers where
`.authentication(...)` was written: `cors()` extended before it still stamps its headers on a 401, and a hook
extended after it does not run for a request the gate rejected. The start-up refusal of an application that
protects a route and never configured authentication is not the gate's — it is a `routeGroups` scan in the
adapter (`assertAuthenticationConfigured`), because the case being refused is the one where no gate exists.

A feature that answers on URLs outside the compiled routing binds a `ServerOwnedPaths` provider with
`.extends(ServerOwnedPaths)`, and a fallback reads them with `container.getManyOptional(ServerOwnedPaths)`.
That is how a SPA shell knows not to swallow `/livez` without `static` importing anything from `health`.

Health is one feature, registered unconditionally like the server, and it is **probes only**. `app.health(...)`
only calls `markExplicit()`, which is what flips the `enabled` default away from the Kubernetes auto-detection —
there is no second fallback configurer, and nothing matches on `[kFeatureName] === 'health'`.

Graceful shutdown — the drain delay, the teardown budget, the signals — is its own feature, `ShutdownBuilder`
from `@caffeinejs/std` (`[kFeatureName] === 'shutdown'`), registered unconditionally by both
`createWebApplication()` and headless `createApplication()` and configured with `app.shutdown(s => …)`. It
publishes the resolved policy under `kShutdownPolicy`; `Application` reads it. Health does not touch
shutdown any more.

The effective authentication schemes are stamped onto each compiled route (`route.authorization.schemes`)
while routing is built, where the application's default scheme is known. A reader that documents or describes
a route takes them from there; plugins register before any Fastify route exists, so `routeOptions.config` is
not available to them outside an `onRoute` hook.

## Two route sources

Routes come from `RouteSource`s, and there are two: `routing/decorated/` reads the `@Controller` registry, `routing/programmatic/` reads the `Router` chains an application mounted. Both produce `RouteGroupSpec` and go through the same `compileRouteGroup`, so a route is configured, guarded and authorized identically whichever way it was written. Common pieces live at the root of `routing/`; a `_`-prefixed file there is private to that directory, so anything both sources need (`inherit.ts`) is not underscore-prefixed.

The compiled group the adapter registers is `RouteGroup`, not `Router` — `Router` is the fluent authoring class. Do not reintroduce `Router` as the compiled shape.

## The two spellings of a route

A verb takes `(path)`, `(path, handler)` or `(path, schema, handler)`. Given a handler the route is closed on the spot and the **group** comes back, not the chain — which is what lets the next route chain off it and what keeps the `RouteDef` accumulating. The schema sits _before_ the handler because TypeScript fixes inferences from non-context-sensitive arguments first, so `S` is resolved by the time the handler's `ctx` is contextually typed; after the handler it would not be.

`.inject()` on both `Router` and `RouteChain` takes a spec or a `(i) => spec` callback handed `$i`. The spec overload must stay **first**: a function type gets no implicit index signature, so an arrow fails the `ObjectInjectionSpec` constraint and falls through, while an object literal never reaches the second. `$i` is handed over at run time rather than re-exported. Both forms are merged identically, so anything reading `#state.injection` cannot tell them apart.

The inline forms are implemented by calling `RouteChain` — `chain.handler(fn)`, or `chain.schema(s).handler(fn)`. There is one registration path and there must stay one, so an inline schema cannot compile differently from a `.schema()` one. Do not grow the inline form a further options argument covering `name` / `authorize` / `guards` / `with`: a route needing those is written with the chain, and a second object-shaped surface would drift from it.

## Extending a route from outside http

`RouteExtension` / `RouteGroupExtension` (`routing/programmatic/extension.ts`) are `(builder) => void` — the _same_ function a decorator hands to `configureRoute`. That is the point: a feature is implemented once as an extension, and the decorator calls it. `@Operation` and `openapi`'s `operation()`, `@Compress` and `@caffeinejs/compress`'s `compress()`, `@BodyAsStream` and `bodyAsStream()` are each one implementation with two spellings. When adding a route-level feature, write the extension first and make the decorator call it — never the other way round, and never two copies.

Applied with `.with(ext, ...rest)` on `Router` and `RouteChain`. An extension may write anything on the builder except `path`, `method`, `parameters` and the handler — `flatten.ts` overwrites those.

A feature that must attach a real Fastify hook to the routes it applies to — resolved from the container, not closed over at decorator time — does it from Fastify's own `onRoute` hook inside its plugin: resolve the dependencies once as the plugin registers, then call `addRouteHook` per route. `@caffeinejs/caching` is the one consumer, and the adapter's only cache-specific line is the start-up refusal of `@Cache` with no caching plugin registered. The hook fires while each route registers, which is after the adapter attached its own — `@UseGuards` included — so what it adds runs behind them. Do not reach for this for anything a `RouteExtension` writing plain route config can express.

## Installing a feature on one group

`router.extend(feature, configure?)` and `@Use(feature, configure?)` install a feature whose plugin registers inside that route group's Fastify context instead of on the root server. The feature itself is installed on the application — one config slice, one bootstrap — and only the plugin is scoped, which is why the same `Feature.name` on the application and on a router is `ErrFeatureAlreadyInstalled`, and why two groups wanting different settings install two instances (`cors()` and `cors('pets')`).

The install happens in `WebApplication.configurers()`, which runs before the declare phase: that is the last moment a feature can register a configuration slice, and the reason `mount()` must be called before the application is ready. `RouteGroup.scopes` carries what installed the plugins for a group — a programmatic group lists its own router and every router it is nested under, so `.extend(...)` inherits downward the way `.with(...)` does; a controller group lists the class.

The configure callback is **not** re-typed against the application's configuration the way `builder.extend` is: a router or a controller is written without knowing which application it will end up in, so a `.config(c => …)` selector there sees `unknown`.

`fst({ … })` (`http/fst.ts`) is the Fastify escape hatch, and the only one: there is deliberately no generic `routeOptions(key, value)` on the chain. Its type omits `method`/`url`/`handler`/`schema`/`config`/`bodyLimit`/`handlerTimeout` because the adapter writes those itself — `config` especially, which carries `config.caffeine` and would break status, headers and per-route auth if clobbered. Do not widen it.

## Route-selection constraints and API versions

Version is a **routing key**, not a runtime `switch`: two handlers for the same method and URL are selected during matching, so it is a Fastify route constraint (`constraints/`). There is one mechanism with two spellings and one sugar:

- `@Constraint(name, value)` / `.constraint(name, value)` — a first-class constraint. `name` is resolved against the constraint registry while the route compiles; an unknown name fails at `ready()`. The value and the request header it reads land on `Route.constraints` (a `Map<string, ResolvedConstraint>`), the same "fold it in where the app default is known" precedent as `route.authorization.schemes` — the OpenAPI generator reads the header from there.
- `@Version(v)` / `.version(v)` — sugar for the `version` constraint. `version` is always registered: Fastify's built-in semver matcher on `Accept-Version`. It is **not** a path — `@Prefix('/v1')` is URI versioning and stays a separate concern.
- `app.constraints(c => c.register(strategy, { header }))` — registers a custom find-my-way constraint strategy (synchronous only). Held on the builder, installed by `constraintsPlugin` with `addConstraintStrategy` before any route registers.

Group constraints inherit to routes that do not set the same key (route wins, via `compile.ts` — same as `config`/`options`). `fst({ constraints: { … } })` still works for `host` and anything the framework has no opinion about; a `constraints` key set **both** through `fst` and first-class fails at compile rather than disagreeing silently. `constraintVaryPlugin` (contributed by `HTTPCoreFeature`, always) adds every constraint header to `Vary` when any route is constrained. A constraint miss is Fastify's 404 — it does not reach `@Catch`, and no default version is invented. `ServerOwnedPaths` (probes, OIDC callbacks) never carry a constraint.

Do not add a version argument to the inline verb form, an app-level `enableVersioning()` switch, a `VERSION_NEUTRAL` catch-all, or a global default version.

## Route-type accumulation

`Router<GD, GP, R>`'s third parameter accumulates a `RouteDef` union, read back with `RoutesOf<T>` through a `__routes` phantom on both `Router` and `WebApplication`. It is groundwork for a typed client; there is no client yet, and the flat union is deliberate so the client's shape can be decided later.

The carrier is the **return value**, not the variable: `.handler()` gives back the router re-typed with the route just closed, so a chain accumulates. Statement style leaves one handle per statement, each naming the same router with one route in its type; `blend(...)` (or `mount(...)`, or `app.mount(...)`) unions them. The variable the routes were opened from stays `never`, and the verb methods cannot mutate a shared type — do not try to "fix" either.

Mounting collapses repeats by `RouterState` identity, which is what makes `mount(pets, list, add)` work when all three are the same object. Dedupe is **sibling-scoped only** — the roots list in `FluentRouteSource`, one parent's `children` in `Router.mount`. Never dedupe globally: `a.mount(shared)` and `b.mount(shared)` push the identical state under different paths and both must register. `mount(path, router)` clones the state, so a prefixed mount is never deduped against an unprefixed one.

A programmatic handler is `(ctx, deps)`. Both arguments are pickers (`$p.context()` and `$p.just(bag)`), so it compiles to the adapter's arity-specialized handler like any decorated one — there is no separate dispatch for it, and there should not be. The dependency bag comes from `container.resolver($i.object(spec))` and is built **once**: its fields are getters that resolve through the binding on access, which is what keeps a single cached bag correct for singleton, transient and request-scoped alike. Do not add per-request resolution on top of it.

## `@Catch` vs unmatched URL

`@Catch` is exception dispatch by **class**, not by URL path. It only sees errors thrown from a handler that already matched.

- Thrown `ErrHTTPNotFound` → `@Catch` / default `ErrHTTP` JSON body
- No route matched → Fastify not-found. Does **not** go through `@Catch`
- `ctx.notFound(body)` sets 404 on a request that **already matched**
- Do not return SPA `index.html` from `@Catch(ErrHTTPNotFound)`

One global `@Catch` per error class. Duplicate global for the same class fails at boot. Per-controller: `@Catch(..., { global: false })` + `@CatchWith`, or a `@Catch` method on the controller.

## Per-request values

Where a value goes depends on who reads it and how long it lives:

| The value is…                                             | Goes to                                     | Read with                   |
| --------------------------------------------------------- | ------------------------------------------- | --------------------------- |
| an injectable service with a lifecycle                    | a request-scoped binding (`Scopes.REQUEST`) | `container.get` / injection |
| a plain value one middleware computes and a handler reads | `ctx.state`                                 | `ctx.state.get(key)`        |
| the authenticated principal                               | `ctx.user`                                  | `ctx.user`                  |
| what each authentication scheme decided                   | `ctx.auth`                                  | `ctx.auth?.find(scheme)`    |
| what the route declared                                   | the route config                            | `ctx.routeConfig`           |
| the application configuration                             | a snapshot on the context                   | `ctx.config`                |
| another feature's own configuration                       | that feature's keyed config slice           | `ctx.config(key)`           |

`ctx.state` is a `Map` on the context, allocated on first touch. It does not participate in DI: no binding, no
destroy callback, no scope. What it may hold is named by the `V` type parameter a router declares with
`.vars<V>()` — written as a call and not `new Router<V>(path)`, because naming one type argument stops the
compiler inferring the rest and would drop the group's path.

`ctx.config` is a snapshot, taken the first time a request reads it and fixed from then on: a refresh landing
mid-request is not observed by a request already under way. Its type is named by `.configType<C>()` on the
router — named apart from `.config()`, which writes the adapter's per-route configuration. The values come from
the application's configuration whether or not a router declared the type.

Calling it — `ctx.config(kHTMLConfig)` — reads a feature's own slice instead, by `featureConfigKey`. That is
the path for a package, which knows neither `C` nor where the slice ended up, since `.config(selector)` is the
application's choice and may not have been made at all. A key nothing registered reads `undefined`, so a
package can fall back to its own defaults rather than require the feature to be installed.

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

`app.use()` registers middleware on Fastify lifecycle hooks (default `onRequest`); it does not wrap the route
handler. It infers the variables a middleware declares but does not check them against the routers it ends up in
front of — the routers are declared elsewhere. A middleware naming variables no router declares is not an error.

## Request scope

When the container has request-scoped bindings, the adapter starts a scope in Fastify `onRequest`. `RequestScope.run` destroys the scope when its callback’s promise settles, and `done()` returns as soon as Fastify reaches its first await — so the callback stays pending until `reply.raw` emits `close`. That is the one signal that fires for a response that finished, one that errored, and a connection the client dropped, which is what keeps a handler that streams and a body still being piped inside their own scope.

Resolving a request-scoped binding after the scope ended throws `ErrOutOfScope`; it does not quietly mint a new instance. `close` follows `finish` by a tick, so a synchronous `onResponse` hook is still inside the scope and one that awaits first is not.

Do not invent a second “stream scope”; if lifetime is wrong, fix how the adapter awaits the request, not a new scope kind.

## `ActionResult`

The adapter special-cases `Responder` (and promises of it). A Fetch `Response` is listed on `ActionResult` but is **not** unwrapped — it is passed to Fastify `send()`. Do not assume `return new Response(stream)` works. `@Produces` only sets `Content-Type`.
