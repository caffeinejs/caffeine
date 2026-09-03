# Factory Classes

A factory class is a `@Configuration`-decorated class whose methods produce bindings
for the container. Each method annotated with `@Provides` acts as a factory: CaffeineIoC
calls it during initialization and registers the returned value under the declared key.

Factory classes are useful when you need to construct instances that cannot be created
by `@Injectable` alone — third-party classes with no decorators, values assembled from
configuration, or instances that depend on runtime parameters.

```ts
import { Configuration, Provides } from '@caffeinejs/di/decorators'
```

:::warning
The `@Configuration` class itself is managed internally by CaffeineIoC and is never meant
to be injected. Do not declare it as a dependency in other classes. Only the bindings
produced by its `@Provides` methods are available in the container.
:::

:::tip
Split configuration into one class per infrastructure concern. Each class handles a
cohesive set of bindings.

```ts
class DatabaseConfig {
  /* DataSource, repositories */
}
class CacheConfig {
  /* CacheStore, session store  */
}
class APIConfig {
  /* HttpClient, rate limiter    */
}
```

:::

---

## Basic usage

```ts
@Configuration()
class InfrastructureConfig {
  @Provides(HttpClient)
  httpClient(): HttpClient {
    return new HttpClient({ timeout: 5_000, retries: 3 })
  }

  @Provides('db.url')
  dbUrl(): string {
    return process.env.DATABASE_URL ?? 'postgres://localhost/app'
  }
}
```

`HttpClient` and `'db.url'` are now resolvable from the container:

```ts
const di = new CaffeineIoC()
await di.init()

di.get(HttpClient) // HttpClient instance
di.get<string>('db.url') // 'postgres://localhost/app'
```

The factory method is called exactly once per `init()` for singleton-scoped bindings
(the default). The return value is stored and reused.

---

## Constructor injection into the factory class

`@Configuration` accepts an optional injection list for its own constructor. Use this
when the factory class itself needs container-managed dependencies to build its
provided values.

```ts
@Configuration([AppConfig])
class DatabaseConfig {
  constructor(private readonly config: AppConfig) {}

  @Provides(DataSource)
  dataSource(): DataSource {
    return new DataSource({
      host: this.config.dbHost,
      port: this.config.dbPort,
    })
  }
}
```

`AppConfig` is resolved by the container and passed to `DatabaseConfig` before any
`@Provides` method is called.

---

## Method-level dependency injection

`@Provides` accepts an optional dependency list as its second argument. CaffeineIoC resolves
those dependencies and passes them as method parameters.

```ts
@Configuration()
class ServiceConfig {
  @Provides(OrderService, [Repository, Logger])
  orderService(repo: Repository, logger: Logger): OrderService {
    return new OrderService(repo, logger)
  }
}
```

Dependencies between `@Provides` methods within the same configuration class are
supported. Use the provided key as the dependency:

```ts
@Configuration()
class AppConfig {
  @Provides(Database)
  database(): Database {
    return new Database(process.env.DATABASE_URL!)
  }

  @Provides(UserRepository, [Database])
  userRepository(db: Database): UserRepository {
    return new UserRepository(db)
  }
}
```

---

## Providing under abstract and symbol keys

`@Provides` accepts any valid key — class constructor, abstract class, string, or
symbol. This is the standard way to wire third-party types or interfaces without
decorating the target class.

```ts
abstract class Logger {
  abstract log(msg: string): void
}

const kMetrics = Symbol('Metrics')

@Configuration()
class ObservabilityConfig {
  @Provides(Logger)
  logger(): Logger {
    return pino() // third-party, no decorators possible
  }

  @Provides(kMetrics)
  metrics(): Metrics {
    return new PrometheusMetrics()
  }
}
```

---

## `@Primary`, `@Named`, and `@Fallback` on factory methods

Factory methods support the same resolution decorators as `@Injectable` classes.

```ts
@Configuration()
class CacheConfig {
  // Default — used when no other CacheStore is @Primary
  @Fallback()
  @Provides(CacheStore)
  memoryCache(): CacheStore {
    return new InMemoryCache()
  }

  // Preferred when Redis is configured
  @Primary()
  @Provides(CacheStore)
  redisCache(): CacheStore {
    return new RedisCache(process.env.REDIS_URL!)
  }

  // Named variant — injectable by name
  @Named('local')
  @Provides(CacheStore)
  localCache(): CacheStore {
    return new LocalCache()
  }
}
```

---

## Scopes

Apply `@Lifetime` to a factory method to control how often it is called. The default
scope is singleton — the method is called once and the result is reused.

```ts
@Configuration()
class ScopedConfig {
  @Lifetime(Scopes.SINGLETON)
  @Provides(HttpClient)
  httpClient(): HttpClient {
    return new HttpClient() // created once
  }

  @Lifetime(Scopes.TRANSIENT)
  @Provides(RequestBuilder)
  requestBuilder(): RequestBuilder {
    return new RequestBuilder() // new instance on every injection
  }
}
```

Setting `@Lifetime` at the class level applies it to all methods that do not declare
their own scope.

---

## Conditional factory methods

Factory methods support `@ConditionalOn` individually. The method is skipped when its
predicate returns `false`. If the class itself carries `@ConditionalOn`, the effective
condition for each method is the AND of the class-level and method-level predicates.

```ts
@Configuration()
@ConditionalOn(() => process.env.REGION === 'eu')
class EUConfig {
  @Provides(PaymentGateway)
  gateway(): PaymentGateway {
    return new StripeEUGateway() // always provided when REGION === 'eu'
  }

  @ConditionalOn(ctx => ctx.container.has(RedisClient))
  @Provides(CacheStore)
  cache(client: RedisClient): CacheStore {
    return new RedisCache(client) // only when REGION === 'eu' AND RedisClient is bound
  }
}
```

See the [Conditional Bindings guide](./conditional-bindings.md) for more.

---

## Profile-gated factory classes

`@Profile` on a configuration class skips the entire class — and all its `@Provides`
methods — when the profile is not active.

```ts
@Configuration()
@Profile('test')
class TestConfig {
  @Provides(PaymentGateway)
  gateway(): PaymentGateway {
    return new StubPaymentGateway()
  }

  @Provides(EmailService)
  email(): EmailService {
    return new NoopEmailService()
  }
}
```

```ts
const di = new CaffeineIoC({ profiles: ['test'] })
await di.init()
```

See the [Profiles guide](./profiles.md) for more.
