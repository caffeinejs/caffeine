# Class

CaffeineIoC supports three injection points on classes: **constructor**, **properties**, and **methods**.
They are applied in that order — property injections happen after construction,
method injections after properties.

## Constructor injection

Dependencies are injected to the constructor.

For **ECMAScript Stage 3** decorators, dependencies must be explicitly passed to the `@Injectable` decorator, following the order of the parameters in the class constructor.

:::tip
Constructor injection is the recommended way. Prefer to use it only.
:::

```ts
import { Injectable } from '@caffeinejs/di'

@Injectable([Database, Logger])
class UserService {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}
}
```

The dep array passed to `@Injectable` is type-checked by position against the
constructor. Swapped tokens, a list that is too short, or `$i.optional(X)` on a
required `X` parameter are type errors. `$i.optional(X)` belongs on
`x?: X` / `x: X | undefined`.

A key that is a string or symbol, and an injection modifier such as `$i.allOf` or
`$i.optional`, go in the same array, in the same positions:

```ts
import { $i, Injectable, token } from '@caffeinejs/di'

const kMySQL = token<Repository>('mysql')
const kMongo = token<Repository>('mongo')

@Injectable([kMySQL, kMongo, $i.allOf(Repository)])
class RepositoryService {
  constructor(
    readonly mysql: Repository,
    readonly mongo: Repository,
    readonly all: Repository[],
  ) {}
}
```

There are no parameter decorators to reach for: TC39 has none, so `@Inject` applies to a
field, accessor or method, never to a constructor parameter.

## Property injection

`@Inject(key)` on a property tells the container to set that field after
construction. Use the non-null assertion (`!`) because TypeScript cannot see
that the container will always fill the field.

```ts
import { Injectable, Inject } from '@caffeinejs/di'

@Injectable()
class ReportService {
  @Inject(Logger)
  private readonly logger!: Logger

  @Inject(Symbol.for('report-store'))
  private readonly store!: ReportStore
}
```

## Method injection

`@Inject([...deps])` on a method injects dependencies as arguments and calls the
method after all property injections have been applied.

```ts
import { Injectable, Inject } from '@caffeinejs/di'

@Injectable()
class ConnectionPool {
  private db!: Database
  private logger!: Logger

  @Inject([Database, Logger])
  setup(db: Database, logger: Logger) {
    this.db = db
    this.logger = logger
    this.logger.log('Pool initialised')
  }
}
```

The dep array must match the method's parameter positions exactly, the same as
with constructor injection.

## Post-construct hook

`@PostConstruct()` on a method marks it as a lifecycle hook that runs after all
injections are complete. Use it for logic that requires all injected values —
constructor, property, and method injections — to already be present.

:::warning
Post-construct hook are sync.  
The container does not wait for them during initialization.
:::

```ts
import { Injectable, PostConstruct } from '@caffeinejs/di'

@Injectable([Config])
class CacheService {
  private client!: CacheClient

  constructor(private readonly config: Config) {}

  @PostConstruct()
  connect() {
    this.client = new CacheClient(this.config.cacheUrl)
  }
}
```

## Destroy hook

A class that implements the `OnDestroy` interface has its `onDestroy()` method
run when the container is disposed via `await di.dispose()`, or the instance is
reset. Use it to release resources like connections, timers, or file handles.
The container detects the method on the prototype at registration — no decorator.

:::info
Destroy hooks can be async.
:::

```ts
import { Injectable, type OnDestroy } from '@caffeinejs/di'

@Injectable([Config])
class CacheService implements OnDestroy {
  private client!: CacheClient

  constructor(private readonly config: Config) {}

  @PostConstruct()
  connect() {
    this.client = new CacheClient(this.config.cacheUrl)
  }

  async onDestroy() {
    await this.client.close()
  }
}
```

## Bootstrap hook

A class that implements `OnBootstrap` has its `onBootstrap()` method run during
`init()`, after every binding has been resolved. Singleton-scoped bindings only.

## Injection order

For reference, the full sequence for a managed class:

1. Constructor called with constructor deps
2. Property injections applied (`@Inject` on fields)
3. Method injections called (`@Inject` on methods)
4. `@PostConstruct` hook runs
