# @caffeinejs/di

CaffeineIoC, the dependency injection container of CaffeineJS, built on standard ECMAScript decorators.

```sh
npm install -E @caffeinejs/di
```

Documentation: [di/docs/README.md](https://github.com/caffeinejs/caffeine/blob/main/di/docs/README.md).

Install every `@caffeinejs/*` package at the same exact version: [Versioning](https://github.com/caffeinejs/caffeine/blob/main/docs/versioning.md).

## Execution context

A container carries one `ContextStorage` that every consumer shares: the request scope, the HTTP adapter's request
context and a resilience attempt each keep a slot of the same frame. A frame is an `ExecutionContext`, an immutable set
of slots, one per `ContextKey`. Starting a frame inside another extends it, so code inside a resilience attempt still
sees the request it runs in.

On Node, every container makes an `AsyncLocalStorage` of its own. Give a container yours with
`bindContextStorage()` before it compiles; the request scope, the HTTP adapter and resilience then all use it:

```ts
import { AsyncLocalStorage } from 'node:async_hooks'

import { CaffeineIoC, contextKey, ExecutionContext } from '@caffeinejs/di'

const container = new CaffeineIoC()
container.bindContextStorage(new AsyncLocalStorage<ExecutionContext>())
await container.init()

const kTenant = contextKey<string>('tenant')
const storage = container.contextStorage

storage.run((storage.getStore() ?? ExecutionContext.ROOT).with(kTenant, 'acme'), () => {
  storage.getStore()?.get(kTenant) // 'acme'
})
```

| API                                   | Does                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `contextKey<T>(description)`          | Creates a slot. Two calls with the same description make two distinct slots.               |
| `ExecutionContext.ROOT`               | The frame with no slot set.                                                                |
| `context.get(key)`                    | The slot's value, `undefined` when unset.                                                  |
| `context.with(key, value)`            | A new frame with the slot set; `context` is unchanged.                                     |
| `context.without(key)`                | A new frame without the slot; `context` is unchanged.                                      |
| `container.bindContextStorage(store)` | Replaces the container's storage. See below for when it may be called.                     |
| `container.contextStorage`            | The bound storage, else the runtime's. Throws `ErrNoContextStorage` when there is neither. |
| `container.hasContextStorage`         | Whether reading `contextStorage` succeeds.                                                 |

Call `bindContextStorage()` before the container compiles and before anything reads `contextStorage`, such as a
request scope opened before `init()`: whatever read the storage keeps its frames there. It throws
`ErrInvalidContainerState` otherwise, so a module cannot bind one, and `ErrInvalidContextStorage` for an object without
`run()` and `getStore()`. A scope factory that keeps the storage reads it when the scope is used, as the request scope
does: one read while the container is built fixes it.

A storage bound with `bindContextStorage()` is carried by `snapshot()`, so a test container built from the
application shares it. Off Node the runtime makes none: bind one before reading `contextStorage`.

## License

[MIT](LICENSE)
