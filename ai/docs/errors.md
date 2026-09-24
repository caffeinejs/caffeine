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

An error the application did not anticipate — a plain `Error`, a driver error, a rejected `fetch` — answers `{ statusCode, error, code: 'ERR_INTERNAL', message: <status phrase> }` and nothing of its own. The status it asked for is kept (a timed-out handler stays 503); its message, and the causes behind it, go to the log only. A 4xx is untouched: its message describes what the caller got wrong, so Fastify's rendering answers and the log records it as information.

`.errorHandling(e => e.exposeStacktrace(config.app.debug))` adds `stacktrace` — the stack plus its chain of causes — to every body this package renders. Off by default, for a development deployment; it is logged as a warning at start-up. A body an `ErrHTTP` carried, anything a `@Catch` handler returned, and Fastify's 4xx are left alone.
