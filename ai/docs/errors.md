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

- `type` is `about:blank` unless the error set one; `title` is a short summary of the kind of problem, the status phrase as RFC 9110 names it (`Unprocessable Content` for 422) unless the error or `.validation()` set one; `detail` is the error's message; `code` is the error's own code, such as `ERR_HTTP_NOT_FOUND` or `ERR_VALIDATION`. An error with no code gets the `ERR_HTTP_*` code of its status.
- `instance`, `category` and `what_you_should_do` are present only when the error set them, `errors` only on a request that fails its schema and on an `ErrHTTP` given entries, and `stacktrace` only with `exposeStacktrace()`.
- `category` classifies the error for a client to branch on (`rate_limit`, `billing`). `what_you_should_do` tells the reader, often an agent, what to do next. The framework sets neither on its own errors.
- `correlation_id` is the request ID (`ctx.req.id`, which Fastify's `genReqId` and `requestIdHeader` server options decide), and is absent when there is none. `timestamp` is when the problem was sent, ISO 8601 in UTC.
- A request that fails its schema is a validation problem: 422 for the body, 400 for the other slots, with an entry in `errors` for each failed rule. See [Validation problems](#validation-problems).
- A request Fastify refuses — malformed JSON, a body over the limit, an unsupported media type — is a problem too, its message as `detail` and Fastify's code as `code`.

Set `type`, `title`, `instance`, `category`, `what_you_should_do`, `errors` and extension members on the error. An extension named like a member above is dropped:

```ts
throw ErrHTTP.builder()
  .statusCode(409)
  .message('Order 42 is already paid')
  .code('ERR_ORDER_PAID')
  .type('https://example.com/problems/order-paid')
  .title('Order already paid')
  .instance('/orders/42')
  .category('billing')
  .whatYouShouldDo('Fetch the order to read its receipt instead of paying again')
  .extension('orderID', '42')
  .build()

// or, on any ErrHTTP subclass
throw new ErrHTTPConflict('Order 42 is already paid', {
  type: '…',
  title: 'Order already paid',
  instance: '/orders/42',
  category: 'billing',
  whatYouShouldDo: '…',
  extensions: { orderID: '42' },
})
```

A business rule that rejects several fields at once lists them as entries, in the shape a validation problem uses. `.errors(...)` adds to the entries already given, `.options({ errors })` replaces them, and every entry is sent: `maxErrors` caps validation problems only.

```ts
throw ErrHTTP.builder()
  .statusCode(422)
  .message('The order cannot be placed')
  .code('ERR_ORDER_REJECTED')
  .errors(
    { code: 'ERR_ITEM_UNAVAILABLE', detail: 'Item 7 is sold out', source: { in: 'body', pointer: '/items/0' } },
    { code: 'ERR_COUPON_EXPIRED', detail: 'Coupon SPRING has expired', source: { in: 'body', pointer: '/coupon' } },
  )
  .build()
```

What stays off the problem:

- An `ErrHTTP` with a `body`, and `ctx.notFound(body)` and the other `ctx` helpers given a body, send that body unchanged under the reply's media type. None of the error's problem members are sent. Without a body, the `ctx` helpers send a problem, negotiated as above.
- A `@Catch` handler's return value goes out as it stands; the framework neither negotiates nor relabels it. A handler that keeps the contract returns `err.toProblem()` (or `newProblem({ status, code, detail })`) and sets the media type itself with `ctx.header('content-type', 'application/problem+json')`. `toProblem()` carries no `correlation_id` or `timestamp`, which describe one response; read `ctx.req.id` for the first.
- Headers on the error, such as `WWW-Authenticate`, are written as before.

A problem the framework renders skips the route's `response` schema, so a schema written for the bodies a route sends itself, such as `404: $t.Object({ message: $t.String() })`, neither fails a thrown `ErrHTTPNotFound` nor strips its members. A body the application sends, a `ctx` helper's body or a `@Catch` return, still goes through it.

An error the application did not anticipate — a plain `Error`, a driver error, a rejected `fetch` — answers a problem with `code: 'ERR_INTERNAL'` and the status phrase as `detail`, and nothing of its own. The status it asked for is kept (a timed-out handler stays 503); its message, and the causes behind it, go to the log only. A 4xx keeps its message as `detail`, since it describes what the caller got wrong, and is logged as information. A request that fails its schema is the exception: its `detail` names the slot that failed.

`.errorHandling(e => e.exposeStacktrace(config.app.debug))` adds `stacktrace` — the stack plus its chain of causes — to every problem the error handler renders. Off by default, for a development deployment; it is logged as a warning at start-up. A body an `ErrHTTP` carried and anything a `@Catch` handler returned are left alone.

### Validation problems

A request that fails its schema answers 422 for the body and 400 for path parameters, the query string and headers, whichever validator ran. Fastify validates the slots in turn and stops at the first that fails, so one problem describes one slot.

```json
{
  "type": "about:blank",
  "title": "Unprocessable Content",
  "status": 422,
  "detail": "Invalid request body",
  "code": "ERR_VALIDATION",
  "errors": [
    {
      "code": "ERR_VALIDATION_MIN_LENGTH",
      "detail": "name must NOT have fewer than 1 characters",
      "source": { "in": "body", "pointer": "/name" },
      "params": { "limit": 1 }
    }
  ],
  "correlation_id": "req-1",
  "timestamp": "2026-10-28T15:30:00.000Z"
}
```

`detail` is `Invalid request body`, `Invalid query string`, `Invalid path parameters` or `Invalid request headers`. Each error the validator reported is an entry of `errors`:

- `code` is `ERR_VALIDATION_` and the JSON Schema keyword in capitals, words split at each change of case: `minLength` gives `ERR_VALIDATION_MIN_LENGTH`, `false schema` gives `ERR_VALIDATION_FALSE_SCHEMA`, and a keyword with no letter or digit gives `ERR_VALIDATION`. An application's own Ajv keyword gets one by the same rule, so keywords that differ only in separators or in the capital that starts a word, such as `fooBar`, `FooBar` and `foo-bar`, share a code.
- `detail` is the field's name, then the validator's message: `q must be >= 1`. The field is the last member of the path, and an array item's is its index (`3 must be string`). A missing member reads after the object that lacks it, `user must have required property 'email'`, and a failure at the slot itself is the message alone. With Ajv's messages turned off, the message is `is invalid`.
- `source` says where. For the body it is `{ in: 'body', pointer }`, an RFC 6901 pointer into the body: `''` is the body itself, and a missing member is pointed at where it would be (`/user/email`). For a parameter it is `{ in, name, pointer }`, with `in` one of `query`, `path` or `header`, as an OpenAPI document names them: `name` is the parameter, a header's in lowercase, and absent when the slot as a whole fails (too few query parameters); `pointer` goes into the parameter's value and is absent when the value as a whole fails (`?ids=1&ids=x` gives `{ in: 'query', name: 'ids', pointer: '/1' }`).
- `params` is what the validator sent, as it sent it: `{ limit: 1 }`, `{ allowedValues: ['x', 'y'] }`, `{ missingProperty: 'email' }`.

| Keyword                                                                                               | `params`                                                           | `code`                                        |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| `type`                                                                                                | `{ type: 'integer' }`                                              | `ERR_VALIDATION_TYPE`                         |
| `required`                                                                                            | `{ missingProperty: 'a' }`                                         | `ERR_VALIDATION_REQUIRED`                     |
| `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`                                          | `{ comparison: '>=', limit: 5 }`                                   | `ERR_VALIDATION_MINIMUM`, and so on           |
| `multipleOf`                                                                                          | `{ multipleOf: 3 }`                                                | `ERR_VALIDATION_MULTIPLE_OF`                  |
| `minLength`, `maxLength`, `minItems`, `maxItems`, `additionalItems`, `minProperties`, `maxProperties` | `{ limit: 3 }`                                                     | `ERR_VALIDATION_MIN_LENGTH`, and so on        |
| `pattern`                                                                                             | `{ pattern: '^a+$' }`                                              | `ERR_VALIDATION_PATTERN`                      |
| `format`                                                                                              | `{ format: 'email' }`                                              | `ERR_VALIDATION_FORMAT`                       |
| `uniqueItems`                                                                                         | `{ i: 1, j: 0 }`                                                   | `ERR_VALIDATION_UNIQUE_ITEMS`                 |
| `enum`                                                                                                | `{ allowedValues: ['x', 'y'] }`                                    | `ERR_VALIDATION_ENUM`                         |
| `const`                                                                                               | `{ allowedValue: 'x' }`                                            | `ERR_VALIDATION_CONST`                        |
| `dependencies`                                                                                        | `{ property: 'a', missingProperty: 'b', depsCount: 1, deps: 'b' }` | `ERR_VALIDATION_DEPENDENCIES`                 |
| `contains`                                                                                            | `{ minContains: 1 }`                                               | `ERR_VALIDATION_CONTAINS`                     |
| `propertyNames`                                                                                       | `{ propertyName: 'badKey' }`                                       | `ERR_VALIDATION_PROPERTY_NAMES`               |
| `anyOf`, `not`                                                                                        | `{}`                                                               | `ERR_VALIDATION_ANY_OF`, `ERR_VALIDATION_NOT` |
| `oneOf`                                                                                               | `{ passingSchemas: [0, 1] }`                                       | `ERR_VALIDATION_ONE_OF`                       |
| `if`                                                                                                  | `{ failingKeyword: 'then' }`                                       | `ERR_VALIDATION_IF`                           |
| `false schema`                                                                                        | `{}`                                                               | `ERR_VALIDATION_FALSE_SCHEMA`                 |

`anyOf` and `propertyNames` report after the errors of what they contain: a value that fails `anyOf: [string, integer]` gives three entries. `contains` does so only with `allErrors` on, and `if` is reported only with it on. A Zod email is a `pattern` beside the `format`, and the pattern fails first: `ERR_VALIDATION_PATTERN`.

A problem lists at most 25 entries. When there were more, `detail` says so: `Invalid request body: showing the first 25 of 31 errors`. A validator the application compiled itself, through `setValidatorCompiler`, that returns an `Error` gives a problem with no `errors`, its message going to the log only.

`.errorHandling(e => e.validation({ … }))` configures this problem. Each call merges over the last, key by key:

| Option      | Default                                                     |
| ----------- | ----------------------------------------------------------- |
| `type`      | `about:blank`                                               |
| `title`     | The status phrase: `Unprocessable Content` or `Bad Request` |
| `code`      | `ERR_VALIDATION`                                            |
| `maxErrors` | 25. An integer of at least 1, or start-up fails             |
| `issue`     | None. `(ctx, issue) => issue`, called on each entry sent    |

```ts
.errorHandling(e => e.validation({
  type: 'https://api.example.com/problems/validation-error',
  title: 'Request validation failed',
  issue: (ctx, issue) => ({ ...issue, detail: translate(ctx.req.header('accept-language'), issue) }),
}))
```

`issue` is synchronous, runs only on the entries sent, and can rewrite an entry but not drop one. One that throws is logged once, and that entry and every later one go out as the framework built them.

A `@Catch` or `@CatchWith` handler for the error still runs first, and is handed Fastify's error with its `validation` array. Its message is `Invalid request body: 31 errors` unless the application set a `schemaErrorFormatter`. When no handler answers it, the framework renders the problem and, whichever formatter ran, logs one line at level info, `Invalid request body: 31 errors` with `{ validation: { slot, total, errors } }`: the entries sent, never the validator's own report.

Ajv stops at the first error by default, as Fastify ships it. An application that wants every one turns on `allErrors`:

```ts
.server(() => ({ factory: { ajv: { customOptions: { allErrors: true } } } }))
```

That makes the validator record every error before any cap applies, as many as a body's items times the fields each one fails: 30,000 items, each missing 20 required fields, record 600,000 errors, and the work grows with the body. Bound every array a route accepts with `maxItems` before turning it on.

A schema is public through its errors: `params` carries its `enum`, `const`, `pattern` and limits, even for a route left out of the OpenAPI document. Never write a secret into a schema, such as a header checked with `$t.Literal(config.apiKey)`; a route whose constraints must stay private drops `params` with `issue`.

An entry can carry text the client chose. Where a schema admits keys it does not name (`additionalProperties` with a schema, `patternProperties`, `$t.Record`, an open query string), the key the client sent is in `name`, `pointer` and `detail`. JSON carries it as a string and the Markdown format escapes its inline markup; a serializer of the application's own, such as one writing HTML, escapes it too:

```ts
function escapeHTML(text: string): string {
  return text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)
}

createWebApplication().errorHandling(e =>
  e.serializer(
    'text/html',
    (_ctx, problem) =>
      `<h1>${escapeHTML(problem.title)}</h1><ul>${(problem.errors ?? [])
        .map(issue => `<li>${escapeHTML(issue.detail)}</li>`)
        .join('')}</ul>`,
  ),
)
```

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

`Errors` and `Stack trace` sections follow when those members are present. Each entry of `Errors` is one list item, its location and its code as code spans, then its detail with inline markup escaped: ``- `query ids /1` `ERR_VALIDATION_TYPE`: 1 must be integer``. `params` are sent in the JSON formats only. Frontmatter values are JSON, and text from the problem cannot open a heading, a fence or a frontmatter block.

`.errorHandling(e => e.serializer(mediaType, (ctx, problem) => string))` renders problems as another format, such as an HTML page for a browser, or replaces a built-in one under the same media type. Escape what it writes: an entry can hold a key the client chose. A serializer that throws is logged, and that problem goes out as `application/json`. The string it returns is sent as UTF-8, so a media type that names another charset fails start-up, as does one with a wildcard or without a subtype.

```ts
.errorHandling(e => e.serializer('text/html', (ctx, problem) => errorPage(problem)))
```

`.errorHandling(e => e.correlationID(ctx => …))` takes `correlation_id` from somewhere other than the request ID, such as the active trace. `undefined` or `''` leaves the member out, and a provider that throws is logged and leaves it out.

```ts
.errorHandling(e => e.correlationID(() => trace.getActiveSpan()?.spanContext().traceId))
```

`@caffeinejs/openapi` lists the error responses it infers (422 for a route with a body schema other than a file upload, 400 for one with a path, query or headers schema, 401, 403) under every format, and `.errors({ bodyValidation, parameterValidation })` changes the first two: the `Problem` schema, or an application `errorSchema`, for the two JSON ones, a string for Markdown, and no schema for one the application added. A status the route declares stays under `application/json`, the type its own body is sent as.
