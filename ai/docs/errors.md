# Errors

Three different “404s”. `@Catch` only sees the first.

| What                                   | Outcome                     | Mechanism                                            |
| -------------------------------------- | --------------------------- | ---------------------------------------------------- |
| Handler throws `ErrHTTPNotFound`       | JSON (or `@Catch` body)     | `http/core/error` — type-based                       |
| No route matched                       | Fastify not-found           | Does **not** go through `@Catch`                     |
| Browser client route (`GET /settings`) | 200 `index.html` for an SPA | A `GET /*` route the application wrote, not `@Catch` |

`@Catch` is exception dispatch by **class**, not by URL path. `@Catch` declares the error types; the application enrols the handler with `.errorHandling(e => e.globalHandlers(H))`. One enrolled handler per error class. Per-controller: declare the handler and name it with `@CatchWith` instead of enrolling it, or use a `@Catch` method on the controller.

`ctx.notFound(body)` sets status 404 on a request that **already matched**.

Same-origin SPA + `/api` is routing, not error handling: the application writes `GET /*` for its client routes and `newRouter('/api').get('/*', …404)` so the API owns its own misses. See [spa.md](spa.md). Do not return `index.html` from `@Catch(ErrHTTPNotFound)`.

## Problem details

Every error body the framework renders itself is an RFC 9457 problem, sent as `application/problem+json` whatever the request's `Accept` says:

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "Pet 42 not found",
  "code": "ERR_HTTP_NOT_FOUND"
}
```

- `type` is `about:blank` unless the error set one; `title` is Node's phrase for `status`; `detail` is the error's message; `code` is the error's own code, such as `ERR_HTTP_NOT_FOUND` or Fastify's `FST_ERR_VALIDATION`. An error with no code gets the `ERR_HTTP_*` code of its status.
- `instance` is present only when the error set one, `errors` only on a schema failure, and `stacktrace` only with `exposeStacktrace()`.
- A schema failure is a 400 whose `errors` lists each failed rule: `{ path: 'body.owner.name', message: 'must NOT have fewer than 1 characters', code: 'minLength' }`. The path starts with the request slot that failed.
- A request Fastify refuses — malformed JSON, a body over the limit, an unsupported media type — is a problem too, its message as `detail` and Fastify's code as `code`.

Set `type`, `instance` and extension members on the error. An extension named like a member above is dropped:

```ts
throw ErrHTTP.builder()
  .statusCode(409)
  .message('Order 42 is already paid')
  .code('ERR_ORDER_PAID')
  .type('https://example.com/problems/order-paid')
  .instance('/orders/42')
  .extension('orderID', '42')
  .build()

// or, on any ErrHTTP subclass
throw new ErrHTTPConflict('Order 42 is already paid', {
  type: '…',
  instance: '/orders/42',
  extensions: { orderID: '42' },
})
```

What stays off the problem:

- An `ErrHTTP` with a `body`, and `ctx.notFound(body)` and the other `ctx` helpers given a body, send that body unchanged under the reply's media type. The error's `type`, `instance` and extensions are not sent. Without a body, the `ctx` helpers send a problem.
- A `@Catch` handler's return value goes out as it stands; the framework never relabels it. A handler that keeps the contract returns `err.toProblem()` (or `newProblem({ status, code, detail })`) and sets the media type itself with `ctx.header('content-type', 'application/problem+json')`. That is how an HTML error page stays possible.
- Headers on the error, such as `WWW-Authenticate`, are written as before.

An error the application did not anticipate — a plain `Error`, a driver error, a rejected `fetch` — answers a problem with `code: 'ERR_INTERNAL'` and the status phrase as `detail`, and nothing of its own. The status it asked for is kept (a timed-out handler stays 503); its message, and the causes behind it, go to the log only. A 4xx keeps its message as `detail`, since it describes what the caller got wrong, and is logged as information.

`.errorHandling(e => e.exposeStacktrace(config.app.debug))` adds `stacktrace` — the stack plus its chain of causes — to every problem the error handler renders. Off by default, for a development deployment; it is logged as a warning at start-up. A body an `ErrHTTP` carried and anything a `@Catch` handler returned are left alone.

`.errorHandling(e => e.problemContentType('application/json'))` sends every problem under another media type, for a client that accepts nothing else. It must be a JSON media type, or start-up fails. `@caffeinejs/openapi` lists error responses under the same type, with a `Problem` schema an application `errorSchema` replaces.
