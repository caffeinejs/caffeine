---
sidebar_label: Building Instances
---

# Building Instances

`build()` and `builder()` let you instantiate a class or function using the
container's registered bindings to satisfy its dependencies — without registering
the class itself as a binding.

This is useful for classes that are created on demand (command handlers, request
processors, one-off jobs) where full container lifecycle management is not needed.

:::warning
Both methods require the container to be initialized. Always call `await di.init()`
before using `build()` or `builder()`.
:::

---

## `build()`

`build(ctor, injections)` creates a single instance immediately. The `injections`
array maps each constructor argument position to a key or injection descriptor.

```ts
import { CaffeineIoC } from '@caffeinejs/di'

@Injectable()
class DatabaseService { /* ... */ }

class ReportGenerator {
  constructor(
    private readonly db: DatabaseService,
    private readonly format: string,
  ) {}

  generate() { /* ... */ }
}

const di = new CaffeineIoC()
await di.init()

// ReportGenerator is not registered — build() creates it on demand
const report = di.build(ReportGenerator, [DatabaseService, useValue('pdf')])
```

The container resolves `DatabaseService` from its registry and passes `'pdf'` as
a literal value. `ReportGenerator` itself is never added to the container.

---

## `builder()`

`builder(ctor, injections)` compiles the injection resolvers once and returns a
reusable factory function `() => T`. Call it repeatedly without paying the
compilation cost each time.

```ts
const makeReport = di.builder(ReportGenerator, [DatabaseService, useValue('pdf')])

const r1 = makeReport()
const r2 = makeReport()
```

Use `builder()` when you need to create many instances of the same class —
transient request handlers, per-item processors, or pooled workers.

---

## Skipping constructor arguments

Pass `null` or `undefined` at a position to leave that argument uninjected. The
constructor receives `null` or `undefined` for that slot; you supply it yourself
or let the class default handle it.

```ts
class OrderHandler {
  constructor(
    private readonly db: DatabaseService,
    private readonly logger: Logger,
    private readonly traceId: string,
  ) {}
}

// db and logger come from the container; traceId is injected as null
const make = di.builder(OrderHandler, [DatabaseService, Logger, null])

// caller controls traceId separately — extend or wrap as needed
const handler = make()
```

---

## Using injection functions

The injections array accepts any injection descriptor, just like constructor
injection in a registered binding.

```ts
import { optional, allOf, useValue } from '@caffeinejs/di'

di.build(NotificationDispatcher, [
  allOf(Notifier),          // array of all Notifier bindings
  optional(RateLimiter),    // undefined if not registered
  useValue({ retries: 3 }), // literal value
])
```

---

## Plain functions

`build()` and `builder()` also work with plain functions, not just classes.

```ts
function createHandler(db: DatabaseService, config: AppConfig) {
  return {
    handle(req: Request) { /* ... */ },
  }
}

const handler = di.build(createHandler, [DatabaseService, AppConfig])
```

---

## When to use `build()` vs `builder()`

| Need | Use |
| --- | --- |
| Single instance, created once | `build()` |
| Multiple instances of the same class | `builder()` — compile once, call many times |
| Class managed by the container lifecycle | `bind().toSelf()` — register it instead |
