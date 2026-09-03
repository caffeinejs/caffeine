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

1. Extend `ErrorHandler<E>`. Decorate `@Catch(ErrHTTPNotFound)` (or `@Catch(ErrHTTP)` for all HTTP errors).
2. `handle(ctx, err)` either `ctx.status(...).body(...)` or return a JSON object / `View`.
3. Global is the default. A second global `@Catch` for the same class fails at boot — use `{ global: false }` and `@CatchWith(Handler)` on the controller or route.
4. Optional: `@Catch(ErrType)` on a **controller method** `(ctx, error)` instead of a separate class.
5. Prefer throwing `ErrHTTPNotFound` in the handler over `ctx.notFound()` if you want `@Catch` to run.

## Shape

```ts
import { Catch, type Context, ErrHTTP, ErrorHandler } from '@caffeinejs/http'

@Catch(ErrHTTP)
export class HTTPErrorHandler extends ErrorHandler<ErrHTTP> {
  async handle(ctx: Context, err: ErrHTTP) {
    ctx.status(err.statusCode)
    return { code: err.code, message: err.message }
  }
}
```

Per-controller:

```ts
@Catch(ErrHTTPNotFound, { global: false })
class PetsNotFoundHandler extends ErrorHandler<ErrHTTPNotFound> {
  /* ... */
}

@CatchWith(PetsNotFoundHandler)
@Controller('/pets')
class PetsController {}
```

## Verify

A test or request that throws `ErrHTTPNotFound` returns 404 and the handler body. A second global `@Catch` for the same type must not boot.

## Related

- `docs/errors.md`, `docs/messages/ERR_HTTP_NOT_FOUND.md`
- `caffeine-http-controller`
