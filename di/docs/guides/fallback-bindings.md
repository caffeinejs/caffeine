# Fallback Bindings

A fallback binding is a last-resort candidate: it is registered only when no other
non-fallback binding exists for the same key. If any regular binding is present, the
fallback is silently skipped.

This makes fallbacks ideal for providing sensible defaults — especially in libraries,
where a component can ship with a built-in implementation that application code
(or other library users) can silently replace without any configuration change.

```ts
import { Fallback } from '@caffeinejs/di/decorators'
```

---

## Basic usage

```ts
abstract class Logger {
  abstract log(msg: string): void
}

// Ships with the library — used only when the application provides nothing else
@Fallback()
@Injectable()
@Extends()
class NoopLogger extends Logger {
  log(_msg: string) {}
}
```

When no other `Logger` binding is registered, `NoopLogger` is the resolved instance.
When any non-fallback `Logger` is present — from the application or another module —
`NoopLogger` is skipped entirely.

---

## The library pattern

The most common use for `@Fallback` is in reusable libraries. The library ships a
working default; consumers override it by declaring their own binding.

```ts
// --- library code ---

abstract class Cache {
  abstract get(key: string): unknown
  abstract set(key: string, value: unknown): void
}

@Fallback()
@Injectable()
@Extends()
class InMemoryCache extends Cache {
  private readonly store = new Map<string, unknown>()
  get(key: string) {
    return this.store.get(key)
  }
  set(key: string, value: unknown) {
    this.store.set(key, value)
  }
}

// --- application code (optional override) ---

@Injectable()
@Extends()
class RedisCache extends Cache {
  constructor(private readonly client: RedisClient) {}
  get(key: string) {
    return this.client.get(key)
  }
  set(key: string, value: unknown) {
    this.client.set(key, JSON.stringify(value))
  }
}
```

When the application registers `RedisCache`, `InMemoryCache` is never instantiated.
When it does not, `InMemoryCache` is used automatically — no import or configuration
required.

---

## `@Fallback` on `@Provides` methods

`@Fallback` works on factory methods inside a `@Configuration` class. This is useful
when a library ships a full configuration class with some methods acting as defaults
and others as mandatory bindings.

```ts
const kCache = Symbol('Cache')
const kMetrics = Symbol('Metrics')

// --- library config ---
@Configuration()
class LibConfig {
  @Fallback()
  @Provides(kCache)
  cache(): Cache {
    return new InMemoryCache() // overridable default
  }

  @Provides(kMetrics)
  metrics(): Metrics {
    return new NoopMetrics() // always registered — not a fallback
  }
}

// --- application config (optional) ---
@Configuration()
class AppConfig {
  @Provides(kCache)
  cache(): Cache {
    return new RedisCache(process.env.REDIS_URL!) // takes precedence
  }
}
```

When both configs are loaded, `AppConfig.cache` wins and `LibConfig.cache` is skipped.
`LibConfig.metrics` is always registered because it is not a fallback.

---

## Combining `@Fallback` with `@ConditionalOn`

Both decorators apply independently. A `@Fallback` + `@ConditionalOn` binding is
registered only when the condition passes **and** no other non-fallback binding exists
for the key. If either check fails, the binding is skipped.

```ts
@Fallback()
@ConditionalOn(() => process.env.NODE_ENV !== 'test')
@Injectable()
@Extends()
class DefaultPaymentGateway extends PaymentGateway {
  // active in non-test environments when no other gateway is registered
}
```

In test environments the condition fails, so the fallback is never registered —
leaving room for a test stub to be the only gateway, or for `optional(PaymentGateway)`
to return `undefined`.

---

## Manual bindings with `.fallback()`

The fluent binder exposes `.fallback()` for decorator-free containers.

```ts
import { CaffeineIoC } from '@caffeinejs/di'

const di = new CaffeineIoC({ decorators: false })

// Library registers its default
di.bind(Cache, t => t.toClass(InMemoryCache).fallback())

// Application optionally registers an override — wins over fallback
di.bind(Cache, t => t.toClass(RedisCache))

await di.init()

di.get(Cache) // RedisCache — InMemoryCache was skipped
```

If the second `bind` call is absent, `InMemoryCache` is used.

Order does not matter. A fallback is resolved during `compile()`, once modules,
profiles and conditionals have settled, so the override wins whether it was bound
before or after the fallback. That matters because services bootstrap concurrently
and cannot control which of them binds first.

Two consequences follow from that timing:

- A fallback-only key is not visible to `has()`, `entries()` or `size` until the
  container is compiled. Every other binding is visible as soon as `bind()` returns.
- When two fallbacks target the same key, the first one registers.

Binding a key by hand never inherits `@Fallback` from the decorated class — an
explicit `bind()` is an override, so only calling `.fallback()` makes it a fallback.

---

## `@Fallback` vs `@ConditionalOn`

Both can suppress a binding, but the mechanism differs.

|                                | `@Fallback`                                     | `@ConditionalOn`                     |
| ------------------------------ | ----------------------------------------------- | ------------------------------------ |
| Trigger                        | Another non-fallback binding exists for the key | A predicate returns `false`          |
| Resolution point               | After all bindings are collected                | During `init()` predicate evaluation |
| Combines with `@ConditionalOn` | Yes — both checks apply                         | —                                    |
| Best for                       | Optional library defaults, safe overrides       | Environment flags, presence checks   |

Use `@Fallback` when the suppression condition is "something else already handles this."
Use `@ConditionalOn` when the suppression condition is "a runtime fact is not met."

See the [Conditional Bindings guide](./conditional-bindings.md) for full `@ConditionalOn`
documentation.
