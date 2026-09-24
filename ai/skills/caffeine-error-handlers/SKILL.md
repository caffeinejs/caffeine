---
name: caffeine-error-handlers
description: >-
  Add Caffeine @Catch / @CatchWith ErrorHandler classes for thrown HTTP errors.
  Use when rendering ErrHTTPNotFound, JSON error bodies, or per-controller error handlers.
  Not SPA index.html fallback and not Fastify setNotFoundHandler.
---

# Error handlers

Use this skill when rendering **thrown** errors. If `ai/docs/errors.md` exists, read it.

Unmatched URLs do not go through `@Catch`. SPA `index.html` is not an error handler.

## Steps

1. Implement `ErrorHandler<E>`. Decorate `@Catch(ErrHTTPNotFound)` (or `@Catch(ErrHTTP)` for all HTTP errors).
2. `handle(ctx, err)` either `ctx.status(...).body(...)` or return a JSON object / `View`.
3. Enrol it on the application: `.errorHandling(e => e.globalHandlers(Handler))`. Declaring the class is not enough — an unenrolled handler renders nothing application-wide.
4. For one controller or route, leave it unenrolled and name it with `@CatchWith(Handler)` instead. Enrolling two handlers for the same error class fails at boot; declaring two is fine.
5. Optional: `@Catch(ErrType)` on a **controller method** `(ctx, error)` instead of a separate class.
6. Prefer throwing `ErrHTTPNotFound` in the handler over `ctx.notFound()` if you want `@Catch` to run.

An application that never calls `.errorHandling(...)` still renders a thrown `ErrHTTP` as the default JSON envelope, and answers anything it did not anticipate with a generic body — `code: 'ERR_INTERNAL'`, the status phrase as `message` — keeping the real message and its causes in the log. Do not write a `@Catch(Error)` handler to get that; it is the default. `.errorHandling(e => e.exposeStacktrace(config.app.debug))` adds `stacktrace` to the bodies this package renders, for a development deployment.

## Shape

```ts
import { Catch, type Context, ErrHTTP, ErrorHandler } from '@caffeinejs/http'

@Catch(ErrHTTP)
export class HTTPErrorHandler implements ErrorHandler<ErrHTTP> {
  async handle(ctx: Context, err: ErrHTTP) {
    ctx.status(err.statusCode)
    return { code: err.code, message: err.message }
  }
}

createWebApplication().errorHandling(e => e.globalHandlers(HTTPErrorHandler))
```

Per-controller — declared, never enrolled:

```ts
@Catch(ErrHTTPNotFound)
class PetsNotFoundHandler implements ErrorHandler<ErrHTTPNotFound> {
  /* ... */
}

@CatchWith(PetsNotFoundHandler)
@Controller('/pets')
class PetsController {}
```

## Verify

A test or request that throws `ErrHTTPNotFound` returns 404 and the handler body. The same handler left out of `globalHandlers(...)` must leave the default envelope in place. Enrolling two handlers for one type must not boot.

## Related

- `docs/errors.md`, `docs/messages/ERR_HTTP_NOT_FOUND.md`
- `caffeine-http-controller`
