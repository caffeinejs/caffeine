# Async Bindings

Use async bindings when creating an instance requires I/O — connecting to a
database, fetching remote configuration, opening a file handle, and similar
operations that return a `Promise`.

CaffeineIoC awaits all async bindings during `init()`, so by the time your code calls
`container.get()`, every async dependency is already resolved and ready.

## Constraints

Async bindings have three hard constraints enforced at `init()`:

- **Scope**: must be singleton or refresh scoped. Transient and request scopes.
- **Always eager**: async bindings are always instantiated during `init()`
  regardless of the binding's lazy setting.
- **No property or method injection**: `@InjectMember` and `@InjectMethod` are
  not supported on async bindings. Pass all dependencies through the factory
  function instead.

## Three ways to declare an async binding

### Fluent API

Use `toAsyncFactory()` on the binder when wiring dependencies in a module:

```ts
import { CaffeineIoC } from '@caffeinejs/di'

const di = new CaffeineIoC(mod => {
  mod.bind(DatabasePool).toAsyncFactory(async ctx => {
    const config = ctx.container.get(AppConfig)
    return createPool(config.databaseUrl)
  })
})

await di.init()
const pool = di.get(DatabasePool)
```

The factory receives a [`ResolutionContext`](../reference/factories.md#resolutioncontext)
so you can pull synchronous dependencies from the container inside the factory body.

### @UseAsyncFactory decorator

Use `@UseAsyncFactory` when you want to keep the async wiring co-located with
the class declaration:

```ts
import { Injectable, UseAsyncFactory } from '@caffeinejs/di/decorators'

@UseAsyncFactory(async ctx => {
  const config = ctx.container.get(AppConfig)
  const pool = await createPool(config.databaseUrl)
  return new DatabasePool(pool)
})
@Injectable()
class DatabasePool {}
```

Note that `@UseAsyncFactory` replaces the constructor — the class body is not
called. The decorator must appear above `@Injectable`.

### @Async + @Provides inside @Configuration

Use `@Async` on a `@Provides` method when grouping related factory methods in
a configuration class:

```ts
import { Configuration, Provides, Async } from '@caffeinejs/di/decorators'

@Configuration([AppConfig])
class InfraConfig {
  constructor(private readonly config: AppConfig) {}

  @Async()
  @Provides(DatabasePool)
  async databasePool(): Promise<DatabasePool> {
    const pool = await createPool(this.config.databaseUrl)
    return new DatabasePool(pool)
  }

  @Async()
  @Provides(RedisClient)
  async redisClient(): Promise<RedisClient> {
    return RedisClient.connect(this.config.redisUrl)
  }
}
```

The order of `@Async` and `@Provides` on the same method does not matter. The
method's return type must be `Promise<T>`, where `T` is the type registered for
the key.

## Ordering between async bindings

If one async binding depends on another, CaffeineIoC topologically sorts them before
calling `init()` — you do not need to declare or enforce the order manually.

```ts
@Configuration()
class InfraConfig {
  @Async()
  @Provides(DatabasePool)
  async databasePool(): Promise<DatabasePool> {
    return createPool(process.env.DATABASE_URL)
  }

  @Async()
  @Provides(UserRepository, [DatabasePool])
  async userRepository(pool: DatabasePool): Promise<UserRepository> {
    // pool is already resolved — CaffeineIoC awaited databasePool() first
    return new UserRepository(pool)
  }
}
```

## Scoping async bindings

Async bindings default to singleton scope. To use refresh scope instead, add
`@Lifetime(Scopes.REFRESH)`:

```ts
import { Injectable, UseAsyncFactory, Lifetime, Scopes } from '@caffeinejs/di/decorators'

@Lifetime(Scopes.REFRESH)
@UseAsyncFactory(async ctx => {
  const config = ctx.container.get(AppConfig)
  return fetchRemoteConfig(config.vaultUrl)
})
@Injectable()
class RemoteConfig {}
```

When a refresh-scoped binding is reset — via `container.refresher.refresh()`,
`container.resetInstances()`, or `container.resetInstance(key)` — async bindings
are re-awaited automatically and the cached instance is replaced.

See [Scopes](../reference/scopes.md) for more on refresh scope.
