# ERR_HTTP_NOT_FOUND

Thrown as `ErrHTTPNotFound` (HTTP 404) from a handler when a resource is missing, and by the server when no route matches.

## Do

```ts
throw new ErrHTTPNotFound(`The requested pet with ID "${id}" was not found`)
```

Render with `@Catch(ErrHTTPNotFound)` or `@Catch(ErrHTTP)`, enrolled with `.errorHandling(e => e.globalHandlers(H))`. Default body uses `code: 'ERR_HTTP_NOT_FOUND'`.

## Do not

- Throw it yourself for an unmatched URL: the server does, and a `@Catch(ErrHTTPNotFound)` handler sees that miss too, so write the handler for both.
- Serve SPA `index.html` from the `@Catch` handler.
- Call `ctx.notFound()` and expect `@Catch(ErrHTTPNotFound)` to run (`ctx.notFound` only sends 404).
