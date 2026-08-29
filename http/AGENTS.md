# `@caffeinejs/http`

Adapter is Fastify. Controllers are `@Controller` + `@Get` / `@Post` / … + `@Args` / `$p`. Throw `ErrHTTPNotFound` (and other `ErrHTTP*`) from handlers. Do not invent Nest `HttpException`.

## `@Catch` vs unmatched URL

`@Catch` is exception dispatch by **class**, not by URL path. It only sees errors thrown from a handler that already matched.

- Thrown `ErrHTTPNotFound` → `@Catch` / default `ErrHTTP` JSON body
- No route matched → Fastify not-found. Does **not** go through `@Catch`
- `ctx.notFound(body)` sets 404 on a request that **already matched**
- Do not return SPA `index.html` from `@Catch(ErrHTTPNotFound)`

One global `@Catch` per error class. Duplicate global for the same class fails at boot. Per-controller: `@Catch(..., { global: false })` + `@CatchWith`, or a `@Catch` method on the controller.

## Request scope

When the container has request-scoped bindings, the adapter starts a scope in Fastify `onRequest` with `requestScopeManager.run(() => done())`. `RequestScope.run` destroys the scope when that callback’s promise settles. Work that continues after the handler returns (streams, piped bodies) can outlive that. Do not invent a second “stream scope”; if lifetime is wrong, fix how the adapter awaits the request, not a new scope kind.

## `ActionResult`

The adapter special-cases `Responder` (and promises of it). A Fetch `Response` is listed on `ActionResult` but is **not** unwrapped — it is passed to Fastify `send()`. Do not assume `return new Response(stream)` works. `@Produces` only sets `Content-Type`.
