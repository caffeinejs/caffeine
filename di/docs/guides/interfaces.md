# Interfaces

TypeScript interfaces are erased at compile time — they do not exist at runtime, so
they cannot be used directly as injection keys. The solution is to create a **symbol or string token** that acts as the runtime key for the interface.

---

## Defining a token

Declare a symbol (or string) alongside the interface and use it everywhere you would otherwise
use the interface type as a key.

```ts
export interface Repository {
  save(entity: unknown): Promise<void>
  findById(id: string): Promise<unknown>
}

export const kRepository = Symbol('Repository')
```

Register an implementation under that token:

```ts
import { Injectable } from '@caffeinejs/di/decorators'

@Injectable(kRepository)
class InMemoryRepository implements Repository {
  async save(entity: unknown) { /* ... */ }
  async findById(id: string) { /* ... */ }
}
```

Inject it using the token:

```ts
@Injectable([kRepository])
class UserService {
  constructor(private readonly repo: Repository) {}
}
```

---

## Multiple implementations with `allOf`

Register multiple implementations under the same symbol token, then collect all of
them with `allOf`.

```ts
import { Injectable, Named } from '@caffeinejs/di/decorators'
import { allOf } from '@caffeinejs/di'

interface Processor {
  process(input: string): string
}

const kProcessor = Symbol('Processor')

@Named(kProcessor)
@Injectable()
class UpperCaseProcessor implements Processor {
  process(input: string) { return input.toUpperCase() }
}

@Named(kProcessor)
@Injectable()
class TrimProcessor implements Processor {
  process(input: string) { return input.trim() }
}

@Named(kProcessor)
@Injectable()
class SanitizeProcessor implements Processor {
  process(input: string) { return input.replace(/<[^>]*>/g, '') }
}

@Injectable([allOf(kProcessor)])
class Pipeline {
  constructor(private readonly processors: Processor[]) {}

  run(input: string): string {
    return this.processors.reduce((acc, p) => p.process(acc), input)
  }
}
```

`@Named(kProcessor)` registers each class under the shared symbol.
`allOf(kProcessor)` collects all of them into an array at injection time.

:::warning
Injecting the token directly — without `allOf` — when multiple implementations are
registered throws `ErrNoUniqueInjectionForKey`. Mark one implementation `@Primary`,
use `@ConditionalOn` so only one survives at runtime, or inject by a more specific
name or token.
:::

---

## Selecting a single implementation with `@Primary`

```ts
import { Injectable, Named, Primary } from '@caffeinejs/di/decorators'

interface UserRepository {
  findById(id: string): Promise<User | undefined>
  save(user: User): Promise<void>
}

const kUserRepository = Symbol('UserRepository')

@Named(kUserRepository)
@Injectable()
class InMemoryUserRepository implements UserRepository {
  private store = new Map<string, User>()
  async findById(id: string) { return this.store.get(id) }
  async save(user: User) { this.store.set(user.id, user) }
}

@Primary()
@Named(kUserRepository)
@Injectable()
class PostgresUserRepository implements UserRepository {
  async findById(id: string) { /* query postgres */ }
  async save(user: User) { /* insert into postgres */ }
}

// Resolves to PostgresUserRepository because it is @Primary
@Injectable([kUserRepository])
class UserService {
  constructor(private readonly repo: UserRepository) {}
}
```

---

## Naming implementations with `@Named`

Assign each implementation a distinct name for targeted injection or runtime dispatch.

```ts
import { Injectable, Named } from '@caffeinejs/di/decorators'
import { mapped } from '@caffeinejs/di'

interface NotificationSender {
  send(message: string, to: string): Promise<void>
}

const kNotificationSender = Symbol('NotificationSender')

@Named(kNotificationSender, 'email')
@Injectable()
class EmailSender implements NotificationSender {
  async send(message: string, to: string) { /* send email */ }
}

@Named(kNotificationSender, 'sms')
@Injectable()
class SmsSender implements NotificationSender {
  async send(message: string, to: string) { /* send SMS */ }
}

// Inject a specific implementation by string name
@Injectable(['email'])
class OrderService {
  constructor(private readonly sender: NotificationSender) {}
}
```

Inject all implementations as a `Map<string, T>` using `mapped()` for runtime dispatch:

```ts
@Injectable([mapped(kNotificationSender)])
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

```ts
import { Injectable, Named, Primary, ConditionalOn } from '@caffeinejs/di/decorators'

interface CacheStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}

const kCacheStore = Symbol('CacheStore')

// Always registered — acts as the default
@Named(kCacheStore)
@Injectable()
class InMemoryCache implements CacheStore {
  private store = new Map<string, string>()
  async get(key: string) { return this.store.get(key) }
  async set(key: string, value: string) { this.store.set(key, value) }
}

// Only registered when a RedisClient binding is present in the container
@Primary()
@ConditionalOn(ctx => ctx.container.has(RedisClient))
@Named(kCacheStore)
@Injectable()
class RedisCache implements CacheStore {
  constructor(private readonly client: RedisClient) {}
  async get(key: string) { return this.client.get(key) }
  async set(key: string, value: string) { await this.client.set(key, value) }
}
```

All bindings are registered before any `@ConditionalOn` predicate runs, so
`ctx.container.has()` is safe to call for any key.

---

## Manual bindings (without decorators)

```ts
import { CaffeineIoC } from '@caffeinejs/di'

interface Cache {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

const kCache = Symbol('Cache')

class MemCache implements Cache {
  private store = new Map<string, string>()
  get(key: string) { return this.store.get(key) }
  set(key: string, value: string) { this.store.set(key, value) }
}

class RedisCache implements Cache {
  get(key: string) { /* ... */ return undefined }
  set(key: string, value: string) { /* ... */ }
}

const di = new CaffeineIoC()

di.bind(kCache, t => t.toClass(RedisCache))

await di.init()

const cache = di.get<Cache>(kCache)         // RedisCache
```

`.names(token)` registers the binding under the symbol token in addition to its own
class key. `.primary()` makes it the default when resolving a single instance by that
token.
