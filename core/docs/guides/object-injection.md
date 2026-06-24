---
sidebar_label: Object Injection
---

# Object Injection

`object()` injects a set of dependencies as a plain object, where each property is
resolved from the container using the key or descriptor you provide. This is useful
when a constructor receives a single configuration-style parameter instead of multiple
positional arguments.

```ts
import { object } from '@caffeine-projects/dicaf'
```

---

## Basic example

```ts
import { Injectable } from '@caffeine-projects/dicaf/decorators'
import { object } from '@caffeine-projects/dicaf'

class UserRepository { /* ... */ }
class EmailService { /* ... */ }

@Injectable([object({ repository: UserRepository, email: EmailService })])
class UserService {
  constructor(private readonly deps: { repository: UserRepository; email: EmailService }) {}

  register(name: string) {
    this.deps.repository.save(name)
    this.deps.email.send(name)
  }
}
```

The container resolves `UserRepository` and `EmailService`, then passes
`{ repository: ..., email: ... }` as the single constructor argument.

---

## Combining with other injection functions

Each property value in the spec can be a plain key, or any injection descriptor
returned by `optional()`, `allOf()`, `provide()`, and so on.

```ts
import { object, optional, allOf } from '@caffeine-projects/dicaf'

@Injectable([
  object({
    cache: optional(CacheService),     // undefined if not registered
    validators: allOf(Validator),      // array of all Validator bindings
    db: DatabaseService,               // required, plain key
  }),
])
class OrderService {
  constructor(private readonly deps: {
    cache?: CacheService
    validators: Validator[]
    db: DatabaseService
  }) {}
}
```

---

## Nested objects

The spec supports nesting: a property value can itself be a nested spec object,
letting you group related dependencies under a sub-key.

```ts
@Injectable([
  object({
    services: {
      user: UserService,
      order: OrderService,
    },
    config: AppConfig,
  }),
])
class AppFacade {
  constructor(private readonly deps: {
    services: { user: UserService; order: OrderService }
    config: AppConfig
  }) {}
}
```

---

## Plain configuration

`object()` works identically without decorators.

```ts
const di = new CaffeineIoC()

di.bind(UserRepository).toSelf()
di.bind(EmailService).toSelf()
di.bind(UserService).toSelf([object({ repository: UserRepository, email: EmailService })])

await di.init()

const svc = di.get(UserService)
```

---

## When to use object injection

Use `object()` when:

- A class already uses a single "deps bag" parameter as a pattern (common in
  functional-style or options-object codebases).
- Constructor arity would be high enough to make positional arguments hard to track.
- You want to make optional dependencies explicit by name rather than by position.

For standard multi-argument constructors, plain positional injection is simpler and
preferred. Reserve `object()` for cases where the object shape is already part of
the component's interface.
