# `@caffeinejs/http`

Adapter is Fastify. Controllers are `@Controller` + `@Get` / `@Post` / … + `@Args` / `$p`. Throw `ErrHTTPNotFound` (and other `ErrHTTP*`) from handlers. Do not invent Nest `HttpException`.

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

`fst({ … })` (`http/fst.ts`) is the Fastify escape hatch, and the only one: there is deliberately no generic `routeOptions(key, value)` on the chain. Its type omits `method`/`url`/`handler`/`schema`/`config`/`bodyLimit`/`handlerTimeout` because the adapter writes those itself — `config` especially, which carries `config.caffeine` and would break status, headers and per-route auth if clobbered. Do not widen it.

## Route-type accumulation

`Router<GD, GP, R>`'s third parameter accumulates a `RouteDef` union, read back with `RoutesOf<T>` through a `__routes` phantom on both `Router` and `AbstractWebApplication`. It is groundwork for a typed client; there is no client yet, and the flat union is deliberate so the client's shape can be decided later.

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

`app.use()` infers the variables a middleware declares but does not check them against the routers it ends up in
front of — the routers are declared elsewhere. A middleware naming variables no router declares is not an error.

## Request scope

When the container has request-scoped bindings, the adapter starts a scope in Fastify `onRequest`. `RequestScope.run` destroys the scope when its callback’s promise settles, and `done()` returns as soon as Fastify reaches its first await — so the callback stays pending until `reply.raw` emits `close`. That is the one signal that fires for a response that finished, one that errored, and a connection the client dropped, which is what keeps a handler that streams and a body still being piped inside their own scope.

Resolving a request-scoped binding after the scope ended throws `ErrOutOfScope`; it does not quietly mint a new instance. `close` follows `finish` by a tick, so a synchronous `onResponse` hook is still inside the scope and one that awaits first is not.

Do not invent a second “stream scope”; if lifetime is wrong, fix how the adapter awaits the request, not a new scope kind.

## `ActionResult`

The adapter special-cases `Responder` (and promises of it). A Fetch `Response` is listed on `ActionResult` but is **not** unwrapped — it is passed to Fastify `send()`. Do not assume `return new Response(stream)` works. `@Produces` only sets `Content-Type`.
