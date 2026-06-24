---
sidebar_label: Factory
---

# Factory

`toFactory(fn)` binds a key to a raw factory function. Unlike `toFunction()`, the
factory receives a `ResolutionContext` — giving it direct access to the container —
instead of having dependencies injected positionally.

```ts
import type { ResolutionContext } from '@caffeine-projects/dicaf'
```

Use `toFactory()` when the set of dependencies is dynamic, conditional, or determined
at resolution time rather than at bind time.

---

## Basic example

```ts
import { CaffeineIoC } from '@caffeine-projects/dicaf'

class DatabaseService { /* ... */ }
class CacheService { /* ... */ }

const REPOSITORY = Symbol('app:repository')

const di = new CaffeineIoC()

di.bind(DatabaseService).toSelf()
di.bind(CacheService).toSelf()

di.bind(REPOSITORY).toFactory(({ container }) => {
  const db = container.get(DatabaseService)
  const cache = container.get(CacheService)
  return { db, cache }
})

await di.init()

const repo = di.get(REPOSITORY)
```

The factory is called once per scope cycle, the same as `toClass()` or `toFunction()`.

---

## Conditional dependencies

`ctx.container.getOptional()` returns `undefined` when a key is not registered.
Use it to make a dependency optional inside the factory body.

```ts
class MetricsService { record(event: string): void { /* ... */ } }

const HANDLER = Symbol('app:handler')

di.bind(HANDLER).toFactory(({ container }) => {
  const metrics = container.getOptional(MetricsService)

  return {
    handle(event: string) {
      metrics?.record(event)
      // ...
    },
  }
})
```

---

## Collecting multiple bindings

`ctx.container.getMany()` returns all bindings registered under a key.

```ts
abstract class Plugin { abstract run(): void }

const RUNNER = Symbol('app:runner')

di.bind(RUNNER).toFactory(({ container }) => {
  const plugins = container.getMany(Plugin)

  return {
    runAll() {
      for (const plugin of plugins) plugin.run()
    },
  }
})
```

---

## Decorator-based: `@UseFactory`

`@UseFactory(factory)` is the decorator equivalent of `toFactory()`. Apply it to a
class alongside `@Injectable()` to replace the default constructor-based instantiation
with a custom factory function.

The factory receives the same `ResolutionContext` and can access `ctx.container` for
manual resolution.

### Customising construction

Use `@UseFactory` when you need to configure a class in a way that constructor
injection alone cannot express — fixed options, external configuration, or wrapping
the class before returning.

```ts
import { Injectable } from '@caffeine-projects/dicaf/decorators'
import { UseFactory } from '@caffeine-projects/dicaf/decorators'

class AppConfig {
  readonly timeout = Number(process.env.TIMEOUT ?? 5000)
}

@UseFactory(({ container }) => {
  const config = container.get(AppConfig)
  return new HttpClient({ timeout: config.timeout, retries: 3 })
})
@Injectable()
class HttpClient {
  constructor(private readonly opts: { timeout: number; retries: number }) {}
}
```

### Returning a different type

The factory is not required to return an instance of the decorated class. This lets
you bind the class key to a plain object, a Proxy, or any other value while keeping
the class as the resolution key.

```ts
interface Repo<T> {
  findById(id: number): T | undefined
  save(entity: T): T
}

function inMemoryRepo<T>(): Repo<T> {
  const store = new Map<number, T>()
  let seq = 1
  return {
    findById: id => store.get(id),
    save: entity => { store.set(seq++, entity); return entity },
  }
}

@UseFactory(() => inMemoryRepo<User>())
@Injectable()
class UserRepository {}

// di.get(UserRepository) returns a Repo<User>, not a UserRepository instance
```

### Accessing `ctx.key` and `ctx.binding`

`ResolutionContext` exposes the binding's key and metadata. This is useful for
generic factory functions reused across multiple classes.

```ts
import type { ResolutionContext } from '@caffeine-projects/dicaf'

function tracingFactory<T>(inner: (ctx: ResolutionContext) => T) {
  return (ctx: ResolutionContext): T => {
    const instance = inner(ctx)
    console.log(`Resolved ${String(ctx.key)}`)
    return instance
  }
}

@UseFactory(tracingFactory(ctx => new OrderService()))
@Injectable()
class OrderService {}
```

---

## When to use `toFactory()` vs `toFunction()`

| Need | Use |
| --- | --- |
| Fixed set of deps, known at bind time | `toFunction(fn, [deps])` |
| Dynamic or conditional deps | `toFactory(ctx => ...)` |
| Deps determined by runtime state | `toFactory(ctx => ...)` |
| Collecting all bindings for a key | `toFactory(ctx => ...)` with `ctx.container.getMany()` |

---

## Async factories

For factories that perform I/O during construction, see [Async Bindings](./async-bindings.md).
