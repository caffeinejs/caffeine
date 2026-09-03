---
sidebar_label: Object Injection
---

# Object Injection

`$i.object()` injects a set of dependencies as a plain object, where each property is
resolved from the container using the key or descriptor you provide. This is useful
when a constructor receives a single configuration-style parameter instead of multiple
positional arguments.

```ts
import { $i } from '@caffeinejs/di'
```

The spec is a valid TypeScript value: a class is the token, and helpers such as
`$i.optional` encode the resolved field type. `InjectedOf<typeof spec>` is that
bag type; `$i.object(spec)` returns `InjectionDescriptor<InjectedOf<typeof spec>>`.

---

## Basic example

```ts
import { Injectable } from '@caffeinejs/di/decorators'
import { $i, type InjectedOf } from '@caffeinejs/di'

class UserRepository { /* ... */ }
class EmailService { /* ... */ }

const spec = { repository: UserRepository, email: EmailService }

@Injectable([$i.object(spec)])
class UserService {
  constructor(private readonly deps: InjectedOf<typeof spec>) {}

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
returned by `$i.optional()`, `$i.allOf()`, `$i.provide()`, and so on.

```ts
import { $i, type InjectedOf } from '@caffeinejs/di'

const spec = {
  cache: $i.optional(CacheService),
  validators: $i.allOf(Validator),
  db: DatabaseService,
}

@Injectable([$i.object(spec)])
class OrderService {
  constructor(private readonly deps: InjectedOf<typeof spec>) {}
}

type OrderDeps = InjectedOf<typeof spec>
// {
//   cache: CacheService | undefined
//   validators: Validator[]
//   db: DatabaseService
// }
```

---

## Nested objects

The spec supports nesting: a property value can itself be a nested spec object,
letting you group related dependencies under a sub-key.

```ts
const spec = {
  services: {
    user: UserService,
    order: OrderService,
  },
  config: AppConfig,
}

@Injectable([$i.object(spec)])
class AppFacade {
  constructor(private readonly deps: InjectedOf<typeof spec>) {}
}
```

---

## Plain configuration

`$i.object()` works identically without decorators.

```ts
const di = new CaffeineIoC()

di.bind(UserRepository, t => t.toSelf())
di.bind(EmailService, t => t.toSelf())
di.bind(UserService, t => t.toSelf([$i.object({ repository: UserRepository, email: EmailService })]))

await di.init()

const svc = di.get(UserService)
```

---

## When to use object injection

Use `$i.object()` when:

- A class already uses a single "deps bag" parameter as a pattern (common in
  functional-style or options-object codebases).
- Constructor arity would be high enough to make positional arguments hard to track.
- You want to make optional dependencies explicit by name rather than by position.

For standard multi-argument constructors, plain positional injection is simpler and
preferred. Reserve `$i.object()` for cases where the object shape is already part of
the component's interface.
