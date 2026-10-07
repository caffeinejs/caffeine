---
sidebar_label: Conditionals
---

# Conditionals

- [$cond](#cond)
- [Condition](#condition)
- [ConditionHelpers](#conditionhelpers)

`$cond` and the types are exported from the main package:

```ts
import { $cond, type Condition, type ConditionHelpers, type Conditions } from '@caffeinejs/di'
```

Conditions are taken by:

- [`@Conditional`](./decorators.md#conditional) — decorator API
- [`BindingSpec.conditional()`](./binding-spec.md#conditional) — fluent API

Both accept one condition, a list, or a callback handed `$cond` that returns either. Every condition must pass for
the binding to be registered. The [Conditionals guide](../guides/conditional-bindings.md) shows them at work.

---

## $cond

```ts
const $cond: ConditionHelpers
```

| Builder               | Passes when                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `present(key)`        | a binding answers to `key`: one registered under it, named after it with `.names()`, or extending it |
| `missing(key)`        | no binding answers to `key`                                                                          |
| `config(test)`        | `test` returns `true` for the values bound with `bindConfig()`                                       |
| `env(name)`           | the environment variable is set, an empty value included                                             |
| `env(name, expected)` | the environment variable equals `expected`                                                           |

```ts
di.bind(Cache, t => t.toClass(InMemoryCache).conditional($cond.missing(Cache)))
di.bind(Mailer, t => t.toClass(SmtpMailer).conditional([$cond.env('SMTP_HOST'), $cond.present(MailTemplates)]))
```

- A condition never sees its own binding.
- A `present(key)` or `missing(key)` on a key a binding without conditions answers to is decided first, then the
  `env` and `config` conditions. Any other `present(key)` or `missing(key)` is decided after every other binding that
  could answer to `key`, and bindings that wait for each other fail the compilation with `ErrCircularCondition`. See
  [When conditions are decided](../guides/conditional-bindings.md#when-conditions-are-decided).
- A `@Provides` method's conditions are decided after its `@Configuration` class: none of them when the class fails,
  and its `env` and `config` only once the class is sure to register.
- `env` and `config` are read when the container compiles, not when the condition is written.
- A `config` condition needs values. Without `bindConfig()`, compiling fails with `ErrNoValuesProvider`.
- A `config` test must return a boolean. Any other result, a Promise included, fails the compilation with
  `ErrInvalidBinding`, and so does a test that throws, with the thrown error as its `cause`.
- A builder checks its arguments when it is called, and throws `ErrInvalidBinding` for a value that is not a key, an
  empty variable name, an `expected` that is not a string, or a test that is not a function.

---

## Condition

```ts
type Condition =
  | { readonly kind: 'present'; readonly key: InjectionToken }
  | { readonly kind: 'missing'; readonly key: InjectionToken }
  | { readonly kind: 'config'; readonly test: (config: never) => boolean }
  | { readonly kind: 'env'; readonly name: string; readonly expected?: string }

type Conditions = Condition | readonly Condition[]
```

A condition is data: its `kind` tells the container what it checks. Build one with `$cond`. A value that is not a
condition of one of these kinds is refused where it is given: `@Conditional` throws `ErrInvalidDecorator`, and
`.conditional()` throws `ErrInvalidBinding`.

---

## ConditionHelpers

```ts
interface ConditionHelpers<C = unknown> {
  present(key: InjectionToken): Condition
  missing(key: InjectionToken): Condition
  config<T = C>(test: (config: T) => boolean): Condition
  env(name: string, expected?: string): Condition
}
```

The type of `$cond`, and of the parameter a callback is handed. `C` types the values a `config` test reads, and a
callback takes it from the type argument of `@Conditional<C>` or `.conditional<C>()`:

```ts
type AppConfig = { cache: { enabled: boolean } }

@Conditional<AppConfig>(c => c.config(cfg => cfg.cache.enabled))
@Injectable()
class CacheWarmer {}
```

Without a type argument, `cfg` is `unknown`. `$cond.config<AppConfig>(cfg => cfg.cache.enabled)` names the type on
the builder instead.
