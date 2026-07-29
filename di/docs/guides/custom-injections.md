# Custom Injections

CaffeineIoC's injection helpers wrap a key into an `InjectionDescriptor`, letting you
modify how a single dependency is resolved — marking it optional, deferring its
key, wrapping it in a provider, or injecting a constant value.

All helpers are exported from the core package:

```ts
import { optional, provide, defer, useValue, compose } from '@caffeinejs/di'
```

:::info
Always use injection functions rather than constructing `InjectionDescriptor` objects
manually. They are more concise, composable, and less error-prone.
:::

They are also available under the `inject` namespace:

```ts
import { inject } from '@caffeinejs/di'

inject.optional(Logger)
inject.provide(EmailSender)
```

## Composition

Injection functions compose by nesting — pass the result of one helper directly
into another. The outermost call determines the final behaviour:

```ts
// injects all Plugin bindings as Plugin[], or undefined if none registered
optional(allOf(Plugin))

// injects all Movie bindings as Map<string, Movie>, or undefined if none registered
optional(mapped('movie'))
```

---

## optional

Marks a dependency as optional. If no binding is registered for the key the
container injects `undefined` instead of throwing.

```ts
import { Injectable } from '@caffeinejs/di/decorators'
import { optional } from '@caffeinejs/di'

@Injectable([optional(FeatureFlags)])
class UserService {
  constructor(private readonly flags?: FeatureFlags) {}
}
```


---

## provide

Wraps the resolved dependency in a `Provider<T>`. Calling `provider.get()`
resolves the dependency on demand, creating a fresh instance for transient
scopes on each call.

Use this to inject a shorter-lived dependency into a longer-lived component
without triggering a scope violation.

```ts
import { Injectable, Lifetime } from '@caffeinejs/di/decorators'
import { provide } from '@caffeinejs/di'
import { Scopes, Provider } from '@caffeinejs/di'

@Injectable([provide(EmailSender)])
@Lifetime(Scopes.SINGLETON)
class NotificationService {
  constructor(private readonly sender: Provider<EmailSender>) {}

  send(msg: string) {
    this.sender.get().send(msg) // new EmailSender on each call
  }
}
```

See [Mixing Scopes](./mixing-scopes.md) for a full explanation of scope
constraints and when `provide` is required.

---

## defer

Defers key resolution until the container constructs the instance. Use this when
a circular module import would cause the class reference to be `undefined` at
declaration time.

```ts
import { Injectable } from '@caffeinejs/di/decorators'
import { defer } from '@caffeinejs/di'

@Injectable([defer(() => B)])
class A {
  constructor(private readonly b: B) {}
}

@Injectable([A])
class B {
  constructor(private readonly a: A) {}
}
```

See [Lazy Bindings](./lazy-bindings.md) for the full circular dependency
strategy.

---

## useValue

Injects a constant value directly. No container binding is required — the value
is passed to the constructor as-is.

```ts
import { Injectable } from '@caffeinejs/di/decorators'
import { useValue } from '@caffeinejs/di'

@Injectable([useValue('localhost'), useValue(5432)])
class DatabaseClient {
  constructor(readonly host: string, readonly port: number) {}
}
```

Useful for primitive configuration values or fixed constants that do not
warrant a full binding.

---

## compose

Composes multiple injection modifier functions around a single key. Each
function receives the key and its result is merged into the descriptor from
left to right.

```ts
import { compose, optional, allOf } from '@caffeinejs/di'

const optionalMany = (key: Key) => compose(key, optional, allOf)

@Injectable([optionalMany(Plugin)])
class App {
  constructor(private readonly plugins?: Plugin[]) {}
}
```

Use `compose` when the same modifier combination appears in multiple places and
you want to name the intent.

---

## Related guides

- [Collections](./collections.md) — inject all bindings for a key as an array (`allOf`) or a map (`mapped`)
- [Object Injection](./object-injection.md) — inject multiple deps as a single plain object (`object`)
- [Mixing Scopes](./mixing-scopes.md) — when and why to use `provide`
- [Lazy Bindings](./lazy-bindings.md) — circular dependency strategies with `defer`
