---
sidebar_label: Conditionals
---

# Conditionals

- [$cond](#cond)
- [ConditionHelpers](#conditionhelpers)
- [Condition](#condition)

All three are exported from the main package:

```ts
import { $cond, type Condition, type ConditionHelpers } from '@caffeinejs/di'
```

A condition is decided once, when the container compiles. When it fails, the binding is not registered for that run.
Conditions are taken by:

- [`@Conditional`](./decorators.md#conditional) — decorator API
- [`BindingSpec.conditional()`](./binding-spec.md#conditional) — fluent API
- [`@Profile`](./decorators.md#profile) and [`BindingSpec.profiles()`](./binding-spec.md#profiles), which are shorthand
  for a `profile` condition

Both `@Conditional` and `.conditional()` take a condition, or a callback handed the helpers. The callback runs once,
when the condition is declared:

```ts
@Conditional(c => c.present(RedisClient))
@Conditional($cond.present(RedisClient)) // the same condition
```

---

## $cond

```ts
const $cond: ConditionHelpers
```

The condition helpers, for a condition built ahead of time and shared by several bindings.

| Helper                     | Passes when                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `present(key)`             | Something answers to the key: a binding registered under it, one named after it, or one extending it. |
| `missing(key)`             | Nothing answers to the key. A binding with this condition on its own key is a default.                |
| `profile(name, ...names)`  | Any of the named profiles is active. With no active profile, it never passes.                         |
| `config(access)`           | The value read through the config provider is `true`.                                                 |
| `config(access, expected)` | The value read through the config provider equals `expected`.                                         |
| `env(name)`                | The environment variable is set to a non-empty value.                                                 |
| `env(name, expected)`      | The environment variable equals `expected`.                                                           |
| `when(test)`               | `test()` returns `true`. It may be async, and it is handed nothing — the container included.          |

`config` takes what `$i.config` takes: a selector, or a dot-separated path. It reads the provider once, while the
container compiles, so the provider must be bound with `toValue()` or `toFactory()`. With none bound, the container
fails with `ErrNoConfigProvider`.

`env` reads `process.env` where there is one; outside Node without it, it never passes.

```ts
const onRedis = $cond.config<AppConfig>(c => c.cache.kind, 'redis')

di.bind(Cache, t => t.toClass(RedisCache).conditional(onRedis))
di.bind(Lock, t => t.toClass(RedisLock).conditional(onRedis))
```

---

## ConditionHelpers

```ts
interface ConditionHelpers<C = unknown>
```

The type of `$cond`, and of the helpers a callback is handed. `C` names the configuration `config` selects from, so a
callback typed `ConditionHelpers<AppConfig>` types `c.config(cfg => cfg.cache.enabled)` without naming the type
again. `@Conditional<AppConfig>(c => …)` binds it.

---

## Condition

```ts
type Condition =
  | { readonly kind: 'present'; readonly key: InjectionToken }
  | { readonly kind: 'missing'; readonly key: InjectionToken }
  | { readonly kind: 'profile'; readonly profiles: readonly string[] }
  | { readonly kind: 'config'; readonly access: ((config: unknown) => unknown) | string; readonly expected: unknown }
  | { readonly kind: 'env'; readonly name: string; readonly expected?: string }
  | { readonly kind: 'when'; readonly test: () => boolean | Promise<boolean> }
```

A condition is data rather than a predicate. The container reads its `kind` to know which keys it checks, and decides a
binding after every held binding answering to one of them: `present` and `missing` check their key, and `config` the
config provider's. Bindings that wait for one another in a cycle are decided first declared first; when no outcome of
the cycle holds together, `init()` fails with `ErrInvalidBinding`. Build one with a helper; `@Conditional` and `.conditional()` reject anything that is not a
condition of one of these kinds with `ErrInvalidDecorator` / `ErrInvalidBinding`.
