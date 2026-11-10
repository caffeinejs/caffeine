# @caffeinejs/di

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
| `container.bindContextStorage(store)` | Replaces the container's storage. Throws `ErrInvalidContainerState` once it has compiled.  |
| `container.contextStorage`            | The bound storage, else the runtime's. Throws `ErrNoContextStorage` when there is neither. |
| `container.hasContextStorage`         | Whether reading `contextStorage` succeeds.                                                 |

A storage bound with `bindContextStorage()` is carried by `snapshot()`, so a test container built from the
application shares it. Off Node the runtime makes none: bind one before reading `contextStorage`.
