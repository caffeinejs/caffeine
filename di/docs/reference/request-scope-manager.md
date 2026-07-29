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
  setStorage(storage: RequestScopeStorage): void
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
`@PreDestroy` hooks). Await it when cleanup ordering matters.

```ts
app.use(async (req, res, next) => {
  await container.requestScopeManager.run(() => next())
})
```

Nested `run()` calls are not supported. Calling `run()` while a scope block is
already active throws `ErrIllegalScopeState`.

Accessing a `REQUEST`-scoped binding outside of a `run()` block throws
`ErrOutOfScope`.

### setStorage

```ts
setStorage(storage: RequestScopeStorage): void
```

Replaces the underlying storage strategy. CaffeineIoC uses `AsyncLocalStorage`
internally by default. Call `setStorage()` only when you need to substitute a
custom implementation — for example, in environments where `AsyncLocalStorage`
is not available or when using a test double.

`setStorage()` must be called before the first `run()`. Calling `run()` with no
storage set throws `ErrNoRequestStorageSet`.

---

## RequestScopeStorage

```ts
interface RequestScopeStorage<T = any> {
  run<R>(context: T, fn: () => R): R
  getStore(): T | undefined
}
```

The storage contract used by the request scope. It mirrors the Node.js
[`AsyncLocalStorage`](https://nodejs.org/api/async_context.html#class-asynclocalstorage)
API, so an `AsyncLocalStorage` instance can be passed directly:

```ts
import { AsyncLocalStorage } from 'node:async_hooks'

container.requestScopeManager.setStorage(new AsyncLocalStorage())
```

---

See [Request scope](./scopes.md#request-scope) for full scope semantics and
[`@Lifetime`](./decorators.md#lifetime) to mark a binding as request-scoped.
