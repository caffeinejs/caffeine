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

Every error body the framework renders itself is an RFC 9457 problem, in the format the request's `Accept` asks for:

```json
{
  "type": "about:blank",
  "title": "Not Found",
  "status": 404,
  "detail": "Pet 42 not found",
  "code": "ERR_HTTP_NOT_FOUND",
  "correlation_id": "req-1",
  "timestamp": "2026-10-28T15:30:00.000Z"
}
```

- `type` is `about:blank` unless the error set one; `title` is Node's phrase for `status`; `detail` is the error's message; `code` is the error's own code, such as `ERR_HTTP_NOT_FOUND` or Fastify's `FST_ERR_VALIDATION`. An error with no code gets the `ERR_HTTP_*` code of its status.
- `instance`, `category` and `what_you_should_do` are present only when the error set them, `errors` only on a schema failure, and `stacktrace` only with `exposeStacktrace()`.
- `category` classifies the error for a client to branch on (`rate_limit`, `billing`). `what_you_should_do` tells the reader, often an agent, what to do next. The framework sets neither on its own errors.
- `correlation_id` is the request ID (`ctx.req.id`, which Fastify's `genReqId` and `requestIdHeader` server options decide), and is absent when there is none. `timestamp` is when the problem was sent, ISO 8601 in UTC.
- A schema failure is a 400 whose `errors` lists each failed rule: `{ path: 'body.owner.name', message: 'must NOT have fewer than 1 characters', code: 'minLength' }`. The path starts with the request slot that failed.
- A request Fastify refuses — malformed JSON, a body over the limit, an unsupported media type — is a problem too, its message as `detail` and Fastify's code as `code`.

Set `type`, `instance`, `category`, `what_you_should_do` and extension members on the error. An extension named like a member above is dropped:

```ts
throw ErrHTTP.builder()
  .statusCode(409)
  .message('Order 42 is already paid')
  .code('ERR_ORDER_PAID')
  .type('https://example.com/problems/order-paid')
  .instance('/orders/42')
  .category('billing')
  .whatYouShouldDo('Fetch the order to read its receipt instead of paying again')
  .extension('orderID', '42')
  .build()

// or, on any ErrHTTP subclass
throw new ErrHTTPConflict('Order 42 is already paid', {
  type: '…',
  instance: '/orders/42',
  category: 'billing',
  whatYouShouldDo: '…',
  extensions: { orderID: '42' },
})
```

What stays off the problem:

- An `ErrHTTP` with a `body`, and `ctx.notFound(body)` and the other `ctx` helpers given a body, send that body unchanged under the reply's media type. None of the error's problem members are sent. Without a body, the `ctx` helpers send a problem, negotiated as above.
- A `@Catch` handler's return value goes out as it stands; the framework neither negotiates nor relabels it. A handler that keeps the contract returns `err.toProblem()` (or `newProblem({ status, code, detail })`) and sets the media type itself with `ctx.header('content-type', 'application/problem+json')`. `toProblem()` carries no `correlation_id` or `timestamp`, which describe one response; read `ctx.req.id` for the first.
- Headers on the error, such as `WWW-Authenticate`, are written as before.

A problem the framework renders skips the route's `response` schema, so a schema written for the bodies a route sends itself, such as `404: $t.Object({ message: $t.String() })`, neither fails a thrown `ErrHTTPNotFound` nor strips its members. A body the application sends, a `ctx` helper's body or a `@Catch` return, still goes through it.

An error the application did not anticipate — a plain `Error`, a driver error, a rejected `fetch` — answers a problem with `code: 'ERR_INTERNAL'` and the status phrase as `detail`, and nothing of its own. The status it asked for is kept (a timed-out handler stays 503); its message, and the causes behind it, go to the log only. A 4xx keeps its message as `detail`, since it describes what the caller got wrong, and is logged as information.

`.errorHandling(e => e.exposeStacktrace(config.app.debug))` adds `stacktrace` — the stack plus its chain of causes — to every problem the error handler renders. Off by default, for a development deployment; it is logged as a warning at start-up. A body an `ErrHTTP` carried and anything a `@Catch` handler returned are left alone.

### Formats

The format follows the request's `Accept`: the highest `q` wins, then an exact type over a wildcard, then the first listed, and a wildcard alone shows no preference. Parameters other than `q` are ignored. Every negotiated problem carries `Vary: Accept`.

| Accept                                                       | Sent as                         |
| ------------------------------------------------------------ | ------------------------------- |
| `application/problem+json`                                   | `application/problem+json`      |
| `application/json`                                           | `application/json`              |
| `text/markdown`, `text/*`                                    | `text/markdown`                 |
| absent, `*/*`, or nothing offered (`text/html`, `image/png`) | `application/json`, never a 406 |

The Markdown puts the members a machine reads in YAML frontmatter and the prose in sections, so an agent branches on fields and reads `What you should do` without parsing a page:

```text
---
type: "about:blank"
title: "Too Many Requests"
status: 429
code: "ERR_PAYMENT_RATE_LIMITED"
category: "rate_limit"
correlation_id: "chk-81"
timestamp: "2026-10-28T15:30:00.000Z"
---

# Too Many Requests

## What happened

12 payment attempts in the last minute

## What you should do

Wait for the Retry-After seconds, then retry once. Do not retry in a loop.
```

`Errors` and `Stack trace` sections follow when those members are present. Frontmatter values are JSON, and text from the problem cannot open a heading, a fence or a frontmatter block.

`.errorHandling(e => e.serializer(mediaType, (ctx, problem) => string))` renders problems as another format, such as an HTML page for a browser, or replaces a built-in one under the same media type. A serializer that throws is logged, and that problem goes out as `application/json`. A media type with a wildcard, or without a subtype, fails start-up.

```ts
.errorHandling(e => e.serializer('text/html', (ctx, problem) => errorPage(problem)))
```

`.errorHandling(e => e.correlationID(ctx => …))` takes `correlation_id` from somewhere other than the request ID, such as the active trace. `undefined` or `''` leaves the member out, and a provider that throws is logged and leaves it out.

```ts
.errorHandling(e => e.correlationID(() => trace.getActiveSpan()?.spanContext().traceId))
```

`@caffeinejs/openapi` lists the error responses it infers (validation, 401, 403) under every format: the `Problem` schema, or an application `errorSchema`, for the two JSON ones, a string for Markdown, and no schema for one the application added. A status the route declares stays under `application/json`, the type its own body is sent as.
