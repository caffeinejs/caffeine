---
sidebar_label: Functions
---

# Functions

`toFunction(fn, injections)` binds a plain function to a key. CaffeineIoC resolves the
declared injections, calls `fn` with those values, and registers whatever `fn` returns
as the binding's value.

This is useful when you want to produce a value — a closure, a plain object, or an
object with methods — without declaring a class.

```ts
import { CaffeineIoC } from '@caffeinejs/di'
```

---

## Returning a function

A function binding can return another function. The injected dependencies are captured
in the closure; callers receive a ready-to-call function.

```ts
class EmailService {
  send(to: string, body: string): void { /* ... */ }
}

const SEND_WELCOME = Symbol('app:send-welcome')

function createWelcomeSender(email: EmailService) {
  return (username: string) => {
    email.send(username, `Welcome, ${username}!`)
  }
}

const di = new CaffeineIoC()

di.bind(EmailService).toSelf()
di.bind(SEND_WELCOME).toFunction(createWelcomeSender, [EmailService])

await di.init()

const sendWelcome = di.get<(username: string) => void>(SEND_WELCOME)
sendWelcome('alice') // sends welcome email
```

---

## Returning a plain object

Use `toFunction` to assemble a plain record or configuration object from container
values.

```ts
class AppConfig {
  readonly baseUrl = process.env.BASE_URL ?? 'http://localhost:3000'
  readonly timeout = 5000
}

const HTTP_OPTIONS = Symbol('app:http-options')

function buildHttpOptions(config: AppConfig) {
  return {
    baseUrl: config.baseUrl,
    timeout: config.timeout,
    headers: { 'Content-Type': 'application/json' },
  }
}

const di = new CaffeineIoC()

di.bind(AppConfig).toSelf()
di.bind(HTTP_OPTIONS).toFunction(buildHttpOptions, [AppConfig])

await di.init()

const options = di.get<ReturnType<typeof buildHttpOptions>>(HTTP_OPTIONS)
```

---

## Returning an object with methods

The module pattern — a plain object with functions as properties — works well with
`toFunction`. Dependencies are closed over once at resolution time.

```ts
class UserRepository {
  findById(id: number) { /* ... */ }
  save(user: unknown) { /* ... */ }
}

class Logger {
  info(msg: string) { /* ... */ }
}

const USER_SERVICE = Symbol('app:user-service')

function createUserService(repo: UserRepository, logger: Logger) {
  return {
    getUser(id: number) {
      logger.info(`fetching user ${id}`)
      return repo.findById(id)
    },
    createUser(data: unknown) {
      const user = repo.save(data)
      logger.info(`created user`)
      return user
    },
  }
}

const di = new CaffeineIoC()

di.bind(UserRepository).toSelf()
di.bind(Logger).toSelf()
di.bind(USER_SERVICE).toFunction(createUserService, [UserRepository, Logger])

await di.init()

const userService = di.get<ReturnType<typeof createUserService>>(USER_SERVICE)
userService.getUser(1)
```

---

## Injection functions

The `injections` array accepts any injection descriptor — the same as constructor
injection.

```ts
import { optional, allOf, useValue } from '@caffeinejs/di'

di.bind(PIPELINE).toFunction(
  (validators, cache, maxItems) => createPipeline(validators, cache, maxItems),
  [
    allOf(Validator),         // array of all Validator bindings
    optional(CacheService),   // undefined if not registered
    useValue(100),            // literal
  ],
)
```

The injection count must equal the function's parameter count. CaffeineIoC throws at bind
time if they differ.

---

## Symbol keys

Functions rarely have a class constructor to use as a key. Use a `Symbol` to give
the binding a stable, collision-free identity. Export it alongside the return type
so callers stay type-safe.

```ts
export const SEND_WELCOME = Symbol('app:send-welcome')
export type WelcomeSender = (username: string) => void

// binding
di.bind(SEND_WELCOME).toFunction(createWelcomeSender, [EmailService])

// consumer
const send = di.get<WelcomeSender>(SEND_WELCOME)
```
