# Abstract Classes

Abstract classes are a first-class pattern in CaffeineIoC.
Use `@Extends` to bind a concrete class to its abstract parent so the container
can resolve it by the abstract type. This is the key decorator for this pattern.

All decorators are imported from `@caffeinejs/di`.

```ts
import { Injectable, Extends, Named, Primary, ConditionalOn } from '@caffeinejs/di'
```

---

## Basic usage

`@Extends()` — without arguments — infers the base class from the `extends` clause.
Pass the base explicitly (`@Extends(Base)`) when you want to be unambiguous or when
extending through an intermediate class.

```ts
import { Injectable, Extends } from '@caffeinejs/di'

abstract class Logger {
  abstract log(message: string): void
}

@Injectable()
@Extends()
class ConsoleLogger extends Logger {
  log(message: string) {
    console.log(message)
  }
}
```

```ts
const di = new CaffeineIoC()
await di.init()

const logger = di.get(Logger) // resolves ConsoleLogger
```

---

## Multiple implementations with `allOf`

Every concrete class decorated with `@Extends` registers itself under the abstract
key. `allOf` collects all of them into an array.

```ts
import { Injectable, Extends } from '@caffeinejs/di'
import { allOf } from '@caffeinejs/di'

abstract class Processor {
  abstract process(input: string): string
}

@Injectable()
@Extends()
class UpperCaseProcessor extends Processor {
  process(input: string) {
    return input.toUpperCase()
  }
}

@Injectable()
@Extends()
class TrimProcessor extends Processor {
  process(input: string) {
    return input.trim()
  }
}

@Injectable()
@Extends()
class SanitizeProcessor extends Processor {
  process(input: string) {
    return input.replace(/<[^>]*>/g, '')
  }
}

@Injectable([allOf(Processor)])
class Pipeline {
  constructor(private readonly processors: Processor[]) {}

  run(input: string): string {
    return this.processors.reduce((acc, p) => p.process(acc), input)
  }
}
```

`allOf(Processor)` collects every binding registered under the `Processor` key.
Order follows registration order unless you control it explicitly through modules.

:::warning
Injecting the abstract key directly — without `allOf` — when multiple implementations
are registered throws `ErrNoUniqueInjectionForKey`. You must disambiguate: mark one
implementation `@Primary`, use `@ConditionalOn` so only one survives at runtime, or
inject a specific concrete class by its own key instead of the abstract one.
:::

---

## Selecting a single implementation with `@Primary`

When multiple implementations are registered, injecting the abstract key directly
(without `allOf`) throws unless exactly one binding is marked `@Primary`.

```ts
import { Injectable, Extends, Primary } from '@caffeinejs/di'

abstract class UserRepository {
  abstract findById(id: string): Promise<User | undefined>
  abstract save(user: User): Promise<void>
}

@Injectable()
@Extends()
class InMemoryUserRepository extends UserRepository {
  private store = new Map<string, User>()
  async findById(id: string) {
    return this.store.get(id)
  }
  async save(user: User) {
    this.store.set(user.id, user)
  }
}

@Primary()
@Injectable()
@Extends()
class PostgresUserRepository extends UserRepository {
  async findById(id: string) {
    /* query postgres */
  }
  async save(user: User) {
    /* insert into postgres */
  }
}

// Resolves to PostgresUserRepository because it is @Primary
@Injectable([UserRepository])
class UserService {
  constructor(private readonly repo: UserRepository) {}
}
```

---

## Naming implementations with `@Named`

Use `@Named` to assign a stable name to an implementation and inject it by that name.

```ts
import { Injectable, Extends, Named } from '@caffeinejs/di'
import { mapped } from '@caffeinejs/di'

abstract class NotificationSender {
  abstract send(message: string, to: string): Promise<void>
}

@Named('email')
@Injectable()
@Extends()
class EmailSender extends NotificationSender {
  async send(message: string, to: string) {
    /* send email */
  }
}

@Named('sms')
@Injectable()
@Extends()
class SmsSender extends NotificationSender {
  async send(message: string, to: string) {
    /* send SMS */
  }
}

// Inject a specific implementation by name
@Injectable(['email'])
class OrderService {
  constructor(private readonly sender: NotificationSender) {}
}
```

Inject all named implementations as a `Map<string, T>` using `mapped()` for
runtime dispatch:

```ts
@Injectable([mapped(NotificationSender)])
class NotificationRouter {
  constructor(private readonly senders: Map<string, NotificationSender>) {}

  async route(channel: string, message: string, to: string) {
    const sender = this.senders.get(channel)
    if (!sender) throw new Error(`No sender for channel: ${channel}`)
    await sender.send(message, to)
  }
}
```

---

## Conditional implementations with `@ConditionalOn`

`@ConditionalOn` registers a binding only when a predicate returns `true` at
container initialization. Useful for environment-driven or feature-flag-driven wiring.

```ts
import { Injectable, Extends, Primary, ConditionalOn, Fallback } from '@caffeinejs/di'

abstract class CacheStore {
  abstract get(key: string): Promise<string | undefined>
  abstract set(key: string, value: string): Promise<void>
}

// Always registered — acts as the default
@Injectable()
@Extends()
@Fallback()
class InMemoryCache extends CacheStore {
  private store = new Map<string, string>()
  async get(key: string) {
    return this.store.get(key)
  }
  async set(key: string, value: string) {
    this.store.set(key, value)
  }
}

// Only registered when a RedisClient binding is present in the container
@Injectable()
@Extends()
@ConditionalOn(ctx => ctx.container.has(RedisClient))
class RedisCache extends CacheStore {
  constructor(private readonly client: RedisClient) {}
  async get(key: string) {
    return this.client.get(key)
  }
  async set(key: string, value: string) {
    await this.client.set(key, value)
  }
}
```

When `RedisClient` is bound, `RedisCache` is registered and wins as `@Primary`.
When absent, the container falls back to `InMemoryCache`.

All bindings are registered before any `@ConditionalOn` predicate runs, so
`ctx.container.has()` is safe to call for any key.

---

## Manual bindings (without decorators)

Use the fluent binder API and call `.extends()` to register a concrete class under
an abstract key without any decorators.

```ts
import { CaffeineIoC } from '@caffeinejs/di'

abstract class Cache {
  abstract get(key: string): string | undefined
  abstract set(key: string, value: string): void
}

class MemCache extends Cache {
  private store = new Map<string, string>()
  get(key: string) {
    return this.store.get(key)
  }
  set(key: string, value: string) {
    this.store.set(key, value)
  }
}

class RedisCache extends Cache {
  get(key: string) {
    /* ... */ return undefined
  }
  set(key: string, value: string) {
    /* ... */
  }
}

const di = new CaffeineIoC()

di.bind(MemCache, t => t.toSelf().extends())
di.bind(RedisCache, t => t.toSelf().extends().primary())

await di.init()

const cache = di.get(Cache) // RedisCache — marked primary
const all = di.getMany(Cache) // [MemCache, RedisCache]
```

:::note
.extends() parameter can be omitted when the key is a class constructor and the
intended extended to be used as key the first one.
:::

`.extends(Base)` registers the binding under both its own key and the abstract key.
`.primary()` makes it the default when resolving a single instance by the abstract key.
The same instance is returned whether you resolve by the concrete or the abstract key.
