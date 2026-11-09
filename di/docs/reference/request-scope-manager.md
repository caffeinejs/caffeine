---
sidebar_label: Request Scope Manager
---

# Request Scope Manager

Accessed via `container.requestScopeManager`. Controls `REQUEST`-scoped
bindings — one instance per asynchronous execution context.

`REQUEST` scope relies on Node.js `AsyncLocalStorage` and is only available in
Node.js environments.

---

## RequestScopeManager

```ts
interface RequestScopeManager {
  run<T>(fn: () => T | Promise<T>): Promise<T>
  setStorage(storage: ContextStorage): void
}
```

### run

```ts
run<T>(fn: () => T | Promise<T>): Promise<Awaited<T>>
```

Starts a new request scope context and runs `fn` inside it. All
`REQUEST`-scoped bindings resolved within the callback — at any depth — return
the same instance for the duration of the call. Always returns a `Promise`
that resolves after all request-scoped instances are destroyed (including any
`onDestroy` hooks). Await it when cleanup ordering matters.

The scope ends when `fn` settles, so `fn` has to stay pending for as long as the
work that depends on the scope. A callback that only hands control to the next
middleware settles immediately, and everything the request does afterwards —
streaming a response, piping a body — runs against a scope that is already gone.
Keep it pending until the work is really over:

```ts
app.use((req, res, next) => {
  void container.requestScopeManager.run(
    () =>
      new Promise<void>(resolve => {
        res.once('close', () => resolve())
        next()
      }),
  )
})
```

Nested `run()` calls are not supported. Calling `run()` while a scope block is
already active throws `ErrIllegalScopeState`.

Accessing a `REQUEST`-scoped binding outside of a `run()` block throws
`ErrOutOfScope`, and so does accessing one after the block that owns it has
ended — a destroyed scope never resolves again.

### setStorage

```ts
setStorage(storage: ContextStorage): void
```

Keeps the request scope's frames on `storage` in place of the container's
`ContextStorage`, the one every container binds on Node. Bind your own
`ContextStorage` instead when the HTTP adapter and other consumers must share
it; call `setStorage()` only when the request scope alone needs a different one.

```ts
import { AsyncLocalStorage } from 'node:async_hooks'

container.requestScopeManager.setStorage(new AsyncLocalStorage())
```

See [Execution context](../../README.md#execution-context) for `ContextStorage`.

---

See [Request scope](./scopes.md#request-scope) for full scope semantics and
[`@Lifetime`](./decorators.md#lifetime) to mark a binding as request-scoped.
