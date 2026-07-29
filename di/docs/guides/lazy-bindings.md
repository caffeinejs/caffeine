# Lazy

By default, CaffeineIoC constructs singleton, container-scoped, and refresh-scoped bindings
eagerly — during `init()`. A lazy binding defers that construction until the binding
is first resolved via `get()`.

```ts
import { Lazy } from '@caffeinejs/di/decorators'
```

---

## Default behaviour by scope

| Scope | Default |
|---|---|
| `SINGLETON` | Eager — constructed during `init()` |
| `CONTAINER` | Eager — constructed during `init()` |
| `REFRESH` | Eager — constructed during `init()` |
| `TRANSIENT` | Always lazy — a new instance is created on every `get()`, never pre-created |

`@Lazy()` overrides the scope default for any scope. `TRANSIENT` ignores the lazy flag
because transient bindings are inherently on-demand.

---

## Basic usage

```ts
@Lazy()
@Injectable()
class HeavyService {
  constructor() {
    // expensive: opens DB pool, starts gRPC channel, etc.
  }
}
```

`HeavyService` is constructed the first time `di.get(HeavyService)` is called — not
during `init()`. If it is never resolved, it is never constructed.

---

## When to use lazy loading

**Expensive startup cost.** Services that open connections, load large caches, or
perform blocking I/O at construction time are good candidates. Lazy loading moves that
cost out of the startup critical path.

```ts
@Lazy()
@Injectable()
class SearchIndexClient {
  private readonly index: VectorIndex

  constructor(config: AppConfig) {
    this.index = VectorIndex.connect(config.searchUrl) // blocking connect
  }
}
```

**Optional services.** A binding that may not be used in every request or code path
can be marked lazy to avoid paying the construction cost when unused.

**Circular dependencies.** Making one participant in a mutual dependency lazy breaks
the cycle — the container constructs the first class immediately and defers the second
until it is needed, by which point the first is already available.

```ts
@Lazy()
@Injectable([ServiceB])
class ServiceA {
  constructor(private readonly b: ServiceB) {}
}

@Injectable([ServiceA])
class ServiceB {
  constructor(private readonly a: ServiceA) {}
}
```

:::warning
Circular dependencies are a design smell. Prefer restructuring the graph or extracting
a shared dependency. Use lazy as a last resort, and enable
`checks: { circularReferences: true }` to detect new cycles early.
:::

---

## `@Lazy(false)` — explicit eagerness

Pass `false` to override a container-level lazy default and force eager construction
for a specific binding.

```ts
// All bindings in this container are lazy by default
const di = new CaffeineIoC({ lazy: true })

@Lazy(false)
@Injectable()
class CriticalStartupService {
  // constructed during init() despite container-wide lazy: true
}
```

This is useful when most of an application's services should start on-demand, but a
few — health check endpoints, telemetry reporters — must be ready before the first
request arrives.

---

## Container-wide lazy default

Set `lazy: true` in the container options to make all bindings lazy unless explicitly
opted out with `@Lazy(false)`.

```ts
const di = new CaffeineIoC({ lazy: true })
await di.init()
// nothing is constructed yet

di.get(SomeService) // constructed here, on first access
```

The priority chain:

1. Binding-level `@Lazy()` / `.lazy()` — highest priority
2. Container-level `lazy` option
3. Scope default (SINGLETON/CONTAINER/REFRESH = eager; TRANSIENT = always lazy)

---

## Manual bindings with `.lazy()`

The fluent binder exposes `.lazy()` for decorator-free containers.

```ts
import { CaffeineIoC } from '@caffeinejs/di'

const di = new CaffeineIoC({ decorators: false })

di.bind(HeavyService)
  .toSelf()
  .lazy()                  // deferred to first get()

di.bind(CriticalService)
  .toSelf()
  .lazy(false)             // constructed during init()

await di.init()
```

---

## Async bindings

Async bindings cannot be lazy. Combining `@Lazy()` with `@UseAsyncFactory` or
`@Async` + `@Provides` throws `ErrInvalidBinding` at container construction time.

```ts
// throws ErrInvalidBinding — async bindings cannot be deferred
@Lazy()
@UseAsyncFactory(async () => createDbConnection())
@Injectable()
class DbConnection {}
```

See the [Async Bindings guide](./async-bindings.md) for more on async factories.
