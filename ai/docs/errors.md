# Errors

Three different “404s”. `@Catch` only sees the first.

| What                                   | Outcome                               | Mechanism                                                                         |
| -------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| Handler throws `ErrHTTPNotFound`       | JSON (or `@Catch` body)               | `http/error` — type-based                                                         |
| No route matched                       | Fastify not-found                     | Does **not** go through `@Catch`                                                  |
| Browser client route (`GET /settings`) | Should be 200 `index.html` for an SPA | Not implemented as a first-class API yet; static `wildcard` 404s the missing file |

`@Catch` is exception dispatch by **class**, not by URL path. One global handler per error class. Per-controller: `@Catch(..., { global: false })` + `@CatchWith`, or a `@Catch` method on the controller.

`ctx.notFound(body)` sets status 404 on a request that **already matched**.

Same-origin SPA + `/api` needs history fallback and an `/api` exclude. That is routing policy, not a second `@Catch`. Do not return `index.html` from `@Catch(ErrHTTPNotFound)`.

Default thrown `ErrHTTP` body: `{ statusCode, error, code, message }` (`code` e.g. `ERR_HTTP_NOT_FOUND`).
