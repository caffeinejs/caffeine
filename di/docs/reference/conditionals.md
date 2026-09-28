---
sidebar_label: Conditionals
---

# Conditionals

- [$cond](#cond)
- [Condition](#condition)
- [ConditionHelpers](#conditionhelpers)

All three are exported from the main package:

```ts
import { $cond, type Condition, type ConditionHelpers } from '@caffeinejs/di'
```

Used by:

- [`BindingSpec.conditional()`](./binding-spec.md#conditional) — fluent API
- [`@Conditional`](./decorators.md#conditional) — decorator API

Both take a condition built with `$cond`, or a callback handed the same builders. The callback runs once, when it is
declared, and must return a condition. Every condition is decided once, during `init()`.

There is no profile condition: restrict a binding to profiles with [`@Profile`](./decorators.md) or
`.profiles()`, which combine with conditions as AND.

---

## $cond

```ts
const $cond: ConditionHelpers
```

The condition builders. Each returns a [`Condition`](#condition).

### present

```ts
present(key: InjectionToken): Condition
```

Passes when a binding answers to `key`: one registered under it, one named after it (`.names()`), or one extending
it (`.extends()`). It is decided after every other binding held for its conditions that answers to `key`, whatever
order they were declared in. The binding being decided never counts.

Throws `ErrMissingInjectionKey` when `key` is `null` or `undefined`.

```ts
di.bind(RedisCacheService, t => t.toSelf().conditional(c => c.present(RedisClient)))
```

### missing

```ts
missing(key: InjectionToken): Condition
```

Passes when no binding answers to `key`. It is decided after every other binding held for its conditions that
answers to `key`, and the binding being decided never counts, so this condition on the binding's own key makes it a
default that yields to any other binding of the key.

Throws `ErrMissingInjectionKey` when `key` is `null` or `undefined`.

```ts
di.bind(Cache, t => t.toClass(InMemoryCache).conditional(c => c.missing(Cache)))
```

### config

```ts
config<T = unknown>(access: ((config: T) => boolean) | string): Condition
config<T = unknown, R = unknown>(access: ((config: T) => R) | string, expected: R): Condition
```

Passes when the value the values provider holds at `access` equals `expected` (`===`). Without `expected`, it passes
only on `true`.

`access` is what [`$i.value`](./injection.md) takes: a selector, or a dot-separated path that stops at the first
`null` or `undefined` link.

The provider is read when the container compiles, before anything resolves, so it must be bound with `toValue()`, or
with `toFactory()` and no injections. `init()` throws `ErrNoValuesProvider` when no provider is bound, and
`ErrInvalidBinding` when it is bound in a form that cannot be read yet, such as `toClass()`.

Throws `ErrInvalidBinding` when `access` is neither a function nor a string.

```ts
c.config('cache.enabled')
c.config('cache.kind', 'redis')
c.config<AppConfig>(cfg => cfg.cache.kind, 'redis')
```

### env

```ts
env(name: string, expected?: string): Condition
```

Passes when the environment variable is set to a non-empty value, or equals `expected` when one is given. The
variable is read when the container compiles. Where the runtime has no `process.env`, it is unset.

Throws `ErrInvalidBinding` when `name` is not a non-empty string.

```ts
c.env('FEATURE_X')
c.env('REGION', 'eu')
```

### when

```ts
when(test: () => boolean | Promise<boolean>): Condition
```

Passes when `test` returns `true`. An async test is awaited. `test` is handed nothing: whether a key is bound is asked
with [`present`](#present) or [`missing`](#missing).

Throws `ErrInvalidBinding` when `test` is not a function.

```ts
c.when(() => featureFlags.isEnabled('new-cache'))
c.when(async () => (await remoteFlags()).isEnabled('new-cache'))
```

---

## Condition

```ts
type Condition =
  | { readonly kind: 'present'; readonly key: InjectionToken }
  | { readonly kind: 'missing'; readonly key: InjectionToken }
  | { readonly kind: 'config'; readonly access: string | ((config: never) => unknown); readonly expected: unknown }
  | { readonly kind: 'env'; readonly name: string; readonly expected?: string }
  | { readonly kind: 'when'; readonly test: () => boolean | Promise<boolean> }
```

A condition is data: its `kind` tells the container what it reads. Build one with [`$cond`](#cond) rather than by
hand, so its arguments are checked where it is written.

Several conditions on one binding are ANDed, and are decided in order until one fails. Stacked `@Conditional`
decorators are decided top-most first.

---

## ConditionHelpers

```ts
interface ConditionHelpers {
  present: typeof present
  missing: typeof missing
  config: typeof config
  env: typeof env
  when: typeof when
}
```

The type of [`$cond`](#cond), and of the builders a `@Conditional` or `.conditional()` callback is handed.
