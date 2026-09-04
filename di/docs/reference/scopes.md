# Scopes

A **scope** determines how many instances of a binding exist and for how long.
Every binding has exactly one scope.

- [Built-in scopes](#built-in-scopes)
  - [Singleton](#singleton)
  - [Transient](#transient)
  - [Request scope](#request-scope)
  - [Refresh scope](#refresh-scope)
- [Scope compatibility](#scope-compatibility)
- [Custom scopes](#custom-scopes)
- [Scope interface](#scope-interface)
- [Scope registry](#scope-registry)
  - [bindScope](#bindscope)
  - [hasScope](#hasscope)
  - [unbindScope](#unbindscope)

---

## Built-in scopes

```ts
import { Scopes } from '@caffeinejs/di'
```

| Identifier         | Decorator                     | Description                                                 |
| ------------------ | ----------------------------- | ----------------------------------------------------------- |
| `Scopes.SINGLETON` | `@Lifetime(Scopes.SINGLETON)` | One instance per container. **Default.**                    |
| `Scopes.TRANSIENT` | `@Lifetime(Scopes.TRANSIENT)` | New instance on every resolution.                           |
| `Scopes.REQUEST`   | `@Lifetime(Scopes.REQUEST)`   | One instance per `AsyncLocalStorage` context. Node.js only. |
| `Scopes.REFRESH`   | `@Lifetime(Scopes.REFRESH)`   | Singleton that can be refreshed via `container.refresher`.  |

Set a scope with the `@Lifetime` decorator or the fluent binder:

```ts
// Decorator
@Injectable()
@Lifetime(Scopes.REQUEST)
class RequestContext { ... }

// Fluent API
di.bind(RequestContext, t => t.toSelf().lifetime(Scopes.REQUEST))
```

---

## Singleton

The default scope. The container creates one instance on first resolution and
returns the same instance on every subsequent `get()`.

```ts
@Injectable()
class DatabasePool {
  constructor() {
    this.pool = createPool()
  }
}
```

`Scopes.SINGLETON` is the default — no decorator needed. Use
`@Lifetime(Scopes.SINGLETON)` only when overriding a parent binding or making
the intent explicit. Singletons are created eagerly during `init()` unless
`lazy: true` is set.

---

## Transient

A new instance is created every time the binding is resolved. Transient
instances are not tracked by the container; `dispose()` does not call
`@PreDestroy` on them.

```ts
@Injectable()
@Lifetime(Scopes.TRANSIENT)
class EmailMessage {
  readonly id = generateId()
}
```

---

## Request scope

One instance per asynchronous execution context. This scope relies on Node.js
`AsyncLocalStorage` and is only available in Node.js environments.

```ts
@Injectable()
@Lifetime(Scopes.REQUEST)
class RequestContext {
  readonly requestId = generateId()
}
```

To start a new request context, run code through
`container.requestScopeManager.run()`:

```ts
app.use((req, res, next) => {
  void container.requestScopeManager.run(
    () =>
      new Promise<void>(resolve => {
        res.once('close', () => resolve())
        next()
      }),
  )
})
```

Any code running within that callback — regardless of how deeply nested — will
resolve the same `RequestContext` instance.

The scope ends when the callback settles, which is why the callback waits for the
response to close rather than returning as soon as `next()` hands control on. See
[request scope manager](./request-scope-manager.md) for the full contract.

---

## Refresh scope

A refresh binding behaves like a singleton but can be refreshed on demand.
After refresh, the next resolution creates a fresh instance.

```ts
@Injectable()
@Lifetime(Scopes.REFRESH)
class RemoteConfig {
  constructor() {
    this.data = loadConfigFromRemote()
  }
}
```

Refresh all refresh-scoped instances:

```ts
await container.refresher.refresh()
```

---

## Scope compatibility

By default, CaffeineIoC enforces compatible-scope rules: a singleton may not depend
on a transient directly, because the transient would be created once and
effectively become a singleton. A refresh-scoped dependency is rejected for the
mirror reason — `refresher.refresh()` replaces the instance and runs its
pre-destroy hook, leaving the singleton with a destroyed object. The container
throws during `init()` if either rule is violated.

Behaviour is controlled by the `checks.scopes` option:

```ts
new CaffeineIoC({ checks: { scopes: 'no-mix' } }) // strict: exact scope match
new CaffeineIoC({ checks: { scopes: 'compatible-scopes-only' } }) // default
new CaffeineIoC({ checks: { scopes: 'off' } }) // no validation
```

To inject a shorter-lived dependency into a longer-lived one, use
[`provide()`](./injection.md) to wrap it in a `Provider`:

```ts
@Injectable([provide(TransientService)])
@Lifetime(Scopes.SINGLETON)
class SomeSingleton {
  constructor(private readonly transient: Provider<TransientService>) {}

  doWork() {
    const svc = this.transient.get() // new instance on every call
  }
}
```

---

## Custom scopes

Implement the `Scope` interface and register it with `bindScope()`. The scope
factory receives the container so the scope can resolve dependencies if needed.

```ts
import { bindScope, type Binding, type Factory, type ResolutionContext, type Scope } from '@caffeinejs/di'

const CUSTOM_SCOPE = Symbol.for('my-app.scope.session')

class CustomScope implements Scope {
  private readonly store = new Map<number, unknown>()

  get lazy() {
    return true
  }

  get durable() {
    return false
  }

  provide<T>(ctx: ResolutionContext, factory: Factory<T>): T {
    const cached = this.store.get(ctx.binding.id)
    if (cached !== undefined) {
      return cached as T
    }

    const instance = factory(ctx)
    this.store.set(ctx.binding.id, instance)
    return instance
  }

  cachedInstance<T>(binding: Binding<T>): T | undefined {
    return this.store.get(binding.id) as T | undefined
  }

  reset(binding: Binding) {
    this.store.delete(binding.id)
  }

  configure(binding: Binding) {
    // Track managed bindings here if the scope needs that metadata.
  }
}

bindScope(CUSTOM_SCOPE, () => new CustomScope())
```

Use the scope in a binding:

```ts
@Injectable()
@Lifetime(CUSTOM_SCOPE)
class UserSession { ... }
```

Scope factories are global — call `bindScope()` once at application startup,
before any `new CaffeineIoC()` call.

---

## Scope interface

```ts
interface Scope {
  get lazy(): boolean
  get durable(): boolean
  provide<T>(ctx: ResolutionContext, factory: Factory<T>): T
  cachedInstance<T>(binding: Binding<T>): T | undefined
  reset(binding: Binding): void | Promise<void>
  configure(binding: Binding): void
}
```

| Member                    | Description                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lazy`                    | When `true`, the container does not eagerly instantiate this scope's bindings during `init()`.                                                          |
| `durable`                 | When `true`, the scope is compatible with other durable scopes during scope validation. Singleton-like scopes are durable; request-like scopes are not. |
| `provide(ctx, factory)`   | Returns an instance for the resolution context. Call `factory(ctx)` to create an uncached instance, or cache the result by `ctx.binding.id`.            |
| `cachedInstance(binding)` | Returns the cached instance for `binding`, or `undefined` if none exists or the scope does not cache instances.                                         |
| `reset(binding)`          | Clears the cached instance for `binding` when the scope supports reset.                                                                                 |
| `configure(binding)`      | Runs once for each binding during container initialization so the scope can track managed bindings.                                                     |

---

## Scope registry

Scopes are registered globally before container creation. A scope factory is a
function that receives a container and returns a `Scope` instance.

```ts
type ScopeFactory = (container: Container) => Scope
```

### bindScope

```ts
bindScope(id, factory)
```

Registers a scope under `id`. Throws `ErrScopeAlreadyRegistered` if `id` is
already bound.

A scope identifier is an ordinary injection token that resolves a `Scope` —
`token<Scope>(...)`. There is no separate scope-key type; the token's invariant
brand is what stops a service key being passed where a scope belongs.

```ts
import { bindScope, token, type Scope } from '@caffeinejs/di'

const MY_SCOPE = token<Scope>(Symbol('my-scope'))

bindScope(MY_SCOPE, container => new MyCustomScope())
```

### hasScope

```ts
hasScope(id)
```

Returns `true` if a scope is registered for `id`.

### unbindScope

```ts
unbindScope(id)
```

Removes the scope registered under `id`.
