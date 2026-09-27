# `@caffeinejs/http`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- The adapter is Fastify. Handlers throw `ErrHTTPNotFound` and the other `ErrHTTP*`; there is no Nest `HttpException`.

## Plugins

- Hand a `@fastify/*` plugin back with its options, `[plugin, options]`, unwrapped; a wrapper with its own body
  still needs `fp()`.
- `.with(...)` is not generic in that pair; write `satisfies` where the shape matters.
- The adapter installs the form body parser itself, before the plugin loop; cookies are parsed before the
  authentication gate, which carries no cookie check.
- A plugin's per-request setting is a Fastify decoration read off `request.server`, as `@caffeinejs/html` does.

## Authentication

- Before a security review of `security/`, read [`security/SECURITY-REVIEW.md`](security/SECURITY-REVIEW.md). Use
  the `security-audit` skill for vulnerabilities and `sharp-edges` for API and option design.
- `assertAuthenticationConfigured` refuses a protected route with no scheme configured, not the gate.
- `skipAuthentication` (`authenticationExempt()`, `exemptFromAuthentication(route)`) skips authenticating, so
  `request.user` stays `null`; `auth.allowAnonymous` still authenticates and skips only authorization. Do not
  merge them.
- `$caffeine` is optional (a 404 has none); `$caffeine.compiled`, never `$caffeine` itself, tells a compiled
  route from a raw one; `$caffeine.auth` is a raw route's policy slot, with no helper yet.
- `isNavigation` (`navigation.ts`) alone reads `Sec-Fetch-*` and `Accept` for that question, so
  `shouldRedirectChallenge` and `@caffeinejs/static`'s `isDocumentRequest` agree.
- Several schemes on one route each append `WWW-Authenticate` with `ctx.appendHeader`, never `ctx.header`.
- A catch-all is the application's: `GET /*` on its own router, marked `detail('http', { internal: true })`,
  throwing `ErrHTTPNotFound` ([`../ai/docs/spa.md`](../ai/docs/spa.md)).
- `ctx.auth` holds per-request authentication state; do not park it on the singleton keyed by the context.
  `AuthenticationService` is its only writer.

## Adapter and types

- The health server hook resolves `ApplicationHealth` before checking `enabled`, since building it rejects a
  non-singleton indicator; nothing invalidates the cache at shutdown.
- `ErrShutdownTimeout` lives in `@caffeinejs/std/shutdown`, not `error/common.ts`.
- No second adapter type for TLS or HTTP/2: TLS is switched by configuration at `bootstrap()`.
- The adapter applies the base path in `rewriteUrl`; never prefix at registration or rewrite `url` in `onRoute`.
  Only `ctx.redirect(...)`, `AuthenticationProperties.redirectURI` and the `returnTo` query resolve `~/`
  (`resolveAppURL`); nothing else is rewritten.
- `req.signal` is read on timed routes only; elsewhere the read would create a controller per request
  (`_tests/handler_timeout.test.ts`).
- `ctx.sent` is asked before every send on somebody else's behalf, and by the route handler before every branch,
  not only `undefined` (`_tests/handler_answered.test.ts`).
- A newly found server-library type becomes a member of `AdapterTypes` (`adapter.ts`), never another type
  parameter.
- No server decoration holds the route table; a plugin needing routes adds an `onRoute` hook
  (`collectRouteGroups(instance)`), not a scan in the adapter.
- `$route` is fire-once, not get-or-create.

## Routes

- Outside the `routing/index.ts` barrel, nothing in `routing/` imports `routing/fastify/`. Do not reintroduce
  `Router` as the compiled shape (`RouteGroup`).
- Keep the verb overloads' order (schema before handler) and the `.inject()` spec overload first; inference
  depends on it. The inline forms call `RouteChain`; do not give them an options argument.
- Write a route-level feature as a `RouteExtension` (`routing/extension.ts`); the decorator calls it.
  `flatten.ts` overwrites `path`, `method`, `parameters` and the handler, so an extension leaves them alone.
- `addRouteHook` replaces a hook slot's array and never mutates it, since Fastify shares it with a GET route's
  HEAD twin; a `RouteExtension` writing plain route config comes first.
- `fst({ … })` (`routing/fastify/route_options.ts`) is the only Fastify escape hatch on a route. Do not widen it:
  its type omits what the adapter writes, `config` included.
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

- Only the adapter builds a request context: `FastifyContext` once per request in `fastify_adapter.ts`, stored as
  `request.httpContext`, and `FastifyContextRequest` lazily by its `req` getter. Code holding a raw
  `FastifyRequest` reads `request.httpContext` (or `request.httpContext.req`); never construct either anywhere
  else, or two contexts disagree on the same request.
- `ctx.state` is application space; a first-party value gets a dedicated member, as `ctx.user`, or the route
  config.
- Do not add a Fastify-named member to `Context` or cast one to `FastifyContext`; `ctx.platform` is the escape
  hatch.
- Do not invent a second "stream scope"; fix how the adapter awaits the request.
- `Responder` is special-cased; a Fetch `Response` on `ActionResult` is passed to Fastify `send()` unwrapped, so
  `return new Response(stream)` does not work. `@Produces` only sets `Content-Type`.
