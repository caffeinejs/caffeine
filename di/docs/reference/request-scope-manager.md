---
sidebar_label: Request Scope Manager
---

# Request Scope Manager

Accessed via `container.requestScopeManager`. Controls `REQUEST`-scoped
bindings — one instance per asynchronous execution context.

A request scope is a slot of the container's context storage, which a
`REQUEST`-scoped binding resolves from. Opening a scope before the container
has initialized throws `ErrInvalidContainerState`. When the container has no
storage, `run` and `enter` throw `ErrNoContextStorage`, and a binding in the
`REQUEST` scope is refused at start-up with `ErrScopeNotRegistered`.

---

## RequestScopeManager

```ts
interface RequestScopeManager {
  run<T>(fn: () => T | Promise<T>): Promise<T>
  enter<T>(fn: (end: () => void | Promise<void>) => T, context?: ExecutionContext): T
}
```

### run

```ts
run<T>(fn: () => T | Promise<T>): Promise<T>
```

Opens a request scope, runs `fn` inside it, and ends the scope once `fn`
settles: the form for a unit of work one callback holds, such as a message
handled from start to finish. All `REQUEST`-scoped bindings resolved within the
callback — at any depth — return the same instance for the duration of the
call. Always returns a `Promise` that resolves after all request-scoped
instances are destroyed (including any `onDestroy` hooks).

Calling `run()` while a scope is already open in the current execution context
throws `ErrIllegalScopeState`.

### enter

```ts
enter<T>(fn: (end: () => void | Promise<void>) => T, context?: ExecutionContext): T
```

Opens a request scope, calls `fn` in it at once, and returns what `fn` returns:
the form for a server whose request outlives every callback. The scope ends when
`end`, handed to `fn`, is called — the caller's to call from the moment `fn`
runs, even when `fn` throws. Async work started in `fn` stays in the scope
until then.

```ts
container.requestScopeManager.enter(end => {
  res.once('close', () => {
    Promise.resolve(end()).catch(err => logger.error({ err }, 'Cannot tear down the request scope'))
  })
  next()
})
```

`end` destroys what the scope produced, in reverse order, inside the scope's
execution context. It returns `undefined` when no destroy hook was registered;
otherwise a `Promise`, rejecting with an `AggregateError` of the hooks that
failed, which the caller must handle. A second call returns what the first did.

The scope's execution context extends `context`, else the current one, so a
server can carry slots of its own in the same frame:

```ts
const kTenant = contextKey<string>('tenant')

container.requestScopeManager.enter(end => handle(end), ExecutionContext.ROOT.with(kTenant, 'acme'))
```

Calling `enter()` while a scope is already open in the current execution
context throws `ErrIllegalScopeState`. A scope that has ended does not count as
open.

### Resolution outside a scope

Accessing a `REQUEST`-scoped binding outside every scope throws
`ErrOutOfScope`, and so does accessing one after the scope that owns it has
ended — a destroyed scope never resolves again.

---

## Context storage

```ts
abstract class ContextStorage {
  abstract run<R>(context: ExecutionContext, fn: () => R): R
  abstract getStore(): ExecutionContext | undefined
}

type ContextStorageFactory = () => ContextStorage

bindContextStorageFactory(factory: ContextStorageFactory): void
container.bindContextStorage(storage: ContextStorage): this
```

One storage per container, which the request scope and the framework keep
their slots in. It has the shape of Node.js
[`AsyncLocalStorage`](https://nodejs.org/api/async_context.html#class-asynclocalstorage),
which satisfies it without extending it, so `instanceof ContextStorage` is
`false` for it.

A container takes its storage from the registered factory once, when it is
constructed. Under Node, `@caffeinejs/di` registers a factory that makes an
`AsyncLocalStorage` for each container, so nothing needs binding. Off Node,
`bindContextStorageFactory` registers one process-wide factory before any
container is constructed; calling it again replaces the factory. With no
factory, a container has no storage.

`container.bindContextStorage(storage)` replaces the container's storage before
`init()`; once the container has started compiling, it throws
`ErrInvalidContainerState`. A snapshot does not carry the storage: every
container binds its own.

When the container initializes, it binds its storage under the key
`ContextStorage` and builds the `REQUEST` scope on it. Inject it to read it:

```ts
@Injectable([ContextStorage])
class Frames {
  constructor(private readonly storage: ContextStorage) {}
}
```

An `ExecutionContext` is immutable: `with(key, value)` returns a new one. A
frame meant to keep the caller's slots extends them:

```ts
const kTenant = contextKey<string>('tenant')

// storage is the injected ContextStorage
storage.run((storage.getStore() ?? ExecutionContext.ROOT).with(kTenant, 'acme'), () => {
  storage.getStore()?.get(kTenant) // 'acme'
})
```

One started from `ExecutionContext.ROOT` hides the caller's slots, the request
scope included.

---

See [Request scope](./scopes.md#request-scope) for full scope semantics and
[`@Lifetime`](./decorators.md#lifetime) to mark a binding as request-scoped.
