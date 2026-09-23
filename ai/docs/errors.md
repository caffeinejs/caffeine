# Errors

Three different “404s”. `@Catch` only sees the first.

| What                                   | Outcome                     | Mechanism                                            |
| -------------------------------------- | --------------------------- | ---------------------------------------------------- |
| Handler throws `ErrHTTPNotFound`       | JSON (or `@Catch` body)     | `http/error` — type-based                            |
| No route matched                       | Fastify not-found           | Does **not** go through `@Catch`                     |
| Browser client route (`GET /settings`) | 200 `index.html` for an SPA | A `GET /*` route the application wrote, not `@Catch` |

`@Catch` is exception dispatch by **class**, not by URL path. `@Catch` declares the error types; the application enrols the handler with `.errorHandling(e => e.globalHandlers(H))`. One enrolled handler per error class. Per-controller: declare the handler and name it with `@CatchWith` instead of enrolling it, or use a `@Catch` method on the controller.

`ctx.notFound(body)` sets status 404 on a request that **already matched**.

Same-origin SPA + `/api` is routing, not error handling: the application writes `GET /*` for its client routes and `newRouter('/api').get('/*', …404)` so the API owns its own misses. See [spa.md](spa.md). Do not return `index.html` from `@Catch(ErrHTTPNotFound)`.

Default thrown `ErrHTTP` body: `{ statusCode, error, code, message }` (`code` e.g. `ERR_HTTP_NOT_FOUND`).
