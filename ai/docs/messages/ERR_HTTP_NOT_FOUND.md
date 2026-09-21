# ERR_HTTP_NOT_FOUND

Thrown as `ErrHTTPNotFound` (HTTP 404) from a **matched** handler when a resource is missing.

## Do

```ts
throw new ErrHTTPNotFound(`The requested pet with ID "${id}" was not found`)
```

Render with `@Catch(ErrHTTPNotFound)` or `@Catch(ErrHTTP)`, enrolled with `.errorHandling(e => e.globalHandlers(H))`. Default body uses `code: 'ERR_HTTP_NOT_FOUND'`.

## Do not

- Use this for an unmatched URL — that is Fastify not-found, not this class (unless you convert it later).
- Serve SPA `index.html` from the `@Catch` handler.
- Call `ctx.notFound()` and expect `@Catch(ErrHTTPNotFound)` to run (`ctx.notFound` only sends 404).
