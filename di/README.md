# @caffeinejs/di

## Execution context

A container carries one `ContextStorage` that every consumer shares: the request scope, the HTTP adapter's request
context and a resilience attempt each keep a slot of the same frame. A frame is an `ExecutionContext`, an immutable set
of slots, one per `ContextKey`. Starting a frame inside another extends it, so code inside a resilience attempt still
sees the request it runs in.

On Node, every container binds an `AsyncLocalStorage` of its own under `ContextStorage`. Bind one yourself to replace
it; the default is bound only where nothing else is:

```ts
import { AsyncLocalStorage } from 'node:async_hooks'

import { CaffeineIoC, ContextStorage, contextKey, ExecutionContext } from '@caffeinejs/di'

const container = new CaffeineIoC()
container.bind(ContextStorage, t => t.toValue(new AsyncLocalStorage<ExecutionContext>()))
await container.init()

const kTenant = contextKey<string>('tenant')
const storage = container.contextStorage

storage.run((storage.getStore() ?? ExecutionContext.ROOT).with(kTenant, 'acme'), () => {
  storage.getStore()?.get(kTenant) // 'acme'
})
```

| API                                     | Does                                                                         |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `contextKey<T>(description)`            | Creates a slot. Two calls with the same description make two distinct slots. |
| `ExecutionContext.ROOT`                 | The frame with no slot set.                                                  |
| `context.get(key)`                      | The slot's value, `undefined` when unset.                                    |
| `context.with(key, value)`              | A new frame with the slot set; `context` is unchanged.                       |
| `context.without(key)`                  | A new frame without the slot; `context` is unchanged.                        |
| `container.contextStorage`              | The bound storage. Throws `ErrInvalidContainerState` before `init()`.        |
| `requestScopeManager.setStorage(store)` | Keeps the request scope alone on `store` in place of the shared storage.     |

Off Node nothing is bound by default, and `container.contextStorage` throws `ErrNoResolutionForKey` until you bind
one.
