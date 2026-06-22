# Class

DiCaf supports three injection points on classes: **constructor**, **properties**, and **methods**.
They are applied in that order — property injections happen after construction,
method injections after properties.

## Constructor injection

Dependencies are injected to the constructor.  

For **ECMAScript Stage 3** decorators, dependencies must be explicitly passed to the `@Injectable` decorator, following the order of the parameters in the class constructor.  

With **TypeScript Legacy** decorators, injections can be inferred by the parameter type, as long as the class type itself is the injection key.

:::tip
Constructor injection is the recommended way. Prefer to use it only.
:::

```ts
import { Injectable } from '@caffeine-projects/dicaf/decorators'

@Injectable([Database, Logger])
class UserService {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}
}
```

The dep array passed to `@Injectable` must match the constructor parameter
positions exactly.

**Legacy decorators:** With `@caffeine-projects/dicaf/decorators/legacy`, 
constructor dependencies whose key is the class constructor itself are inferred automatically from TypeScript's type metadata — the `deps` array can be omitted:

```ts
import { Injectable } from '@caffeine-projects/dicaf/decorators/legacy'

@Injectable()
class UserService {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}
}
```

:::info
For Legacy Decorators, make sure to enable Experimental decorators and Emit Decorator Metadata options in your tsconfig.json to use this library:
```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```
:::

When a key is a string, symbol, or you need to use an injection modifier (like `allOf`, `optional`), use
`@Inject(key)` on each parameter instead — inference only covers class
constructor keys:

```ts
import { Injectable, Inject } from '@caffeine-projects/dicaf/decorators/legacy'
import { allOf } from '@caffeine-projects/dicaf'

@Injectable()
class RepositoryService {
  constructor(
    @Inject('mysql') readonly mysql: Repository,
    @Inject('mongo') readonly mongo: Repository,
    @Inject(allOf(Repository)) readonly all: Repository[],
  ) {}
}
```

## Property injection

`@Inject(key)` on a property tells the container to set that field after
construction. Use the non-null assertion (`!`) because TypeScript cannot see
that the container will always fill the field.

```ts
import { Injectable, Inject } from '@caffeine-projects/dicaf/decorators'

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
import { Injectable, Inject } from '@caffeine-projects/dicaf/decorators'

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
import { Injectable, PostConstruct } from '@caffeine-projects/dicaf/decorators'

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

## Pre-destroy hook

`@PreDestroy()` on a method registers a teardown callback that runs when the
container is disposed via `await di.dispose()`, or the instance is reset. Use it to release resources like
connections, timers, or file handles.

:::info
Pre-destroy hooks can be async.
:::

```ts
import { Injectable, PreDestroy } from '@caffeine-projects/dicaf/decorators'

@Injectable([Config])
class CacheService {
  private client!: CacheClient

  constructor(private readonly config: Config) {}

  @PostConstruct()
  connect() {
    this.client = new CacheClient(this.config.cacheUrl)
  }

  @PreDestroy()
  async disconnect() {
    await this.client.close()
  }
}
```

## Injection order

For reference, the full sequence for a managed class:

1. Constructor called with constructor deps
2. Property injections applied (`@Inject` on fields)
3. Method injections called (`@Inject` on methods)
4. `@PostConstruct` hook runs
