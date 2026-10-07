# Conditionals

`@Conditional` registers a binding only when its conditions pass. A condition is data built with `$cond`, and the
container decides it when it compiles: a binding that fails a condition is never added to the container.

This is the tool for environment-driven wiring: selecting the right implementation from an environment variable, a
setting in the configuration, or the presence of another binding.

---

## How `@Conditional` works

```ts
import { $cond, Conditional } from '@caffeinejs/di'
```

There are four kinds of condition:

| Condition                   | Passes when                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------- |
| `$cond.present(key)`        | a binding answers to `key`: one registered under it, named after it, or extending it     |
| `$cond.missing(key)`        | no binding answers to `key`                                                              |
| `$cond.config(test)`        | `test` returns `true` for the values bound with `bindConfig()`                           |
| `$cond.env(name, expected)` | the environment variable equals `expected`, or is set at all when `expected` is left out |

`@Conditional` takes one condition, a list, or a callback handed `$cond` that returns either. These three are the
same:

```ts
@Conditional($cond.present(RedisClient))
@Conditional([$cond.present(RedisClient)])
@Conditional(c => c.present(RedisClient))
```

The callback runs once, when the decorator is applied. It is handed the condition builders, not the container: a
condition says what to check, and the container checks it, once every binding is declared. See
[When conditions are decided](#when-conditions-are-decided).

:::warning
A binding that fails its condition is completely absent from the container. Any
hard injection of that key will throw `ErrNoResolutionForKey`. Use `optional()`
for dependencies that may not be present.
:::

---

## Region-based implementations

A realistic pattern: different infrastructure implementations are loaded based on a
`REGION` environment variable. One abstract base defines the contract; each
region-specific class registers only when its region matches.

```ts
import { Injectable, Extends, Conditional } from '@caffeinejs/di'
```

### Define the contract

```ts
abstract class PaymentGateway {
  abstract charge(amount: number, currency: string): Promise<{ transactionId: string }>
  abstract refund(transactionId: string): Promise<void>
}
```

### Region-specific implementations

```ts
// Loaded only in EU deployments
@Conditional(c => c.env('REGION', 'eu'))
@Injectable()
@Extends()
class StripeEUGateway extends PaymentGateway {
  async charge(amount: number, currency: string) {
    // Stripe EU endpoint, GDPR-compliant processing
    return { transactionId: `eu_${crypto.randomUUID()}` }
  }
  async refund(transactionId: string) {
    // refund via Stripe EU
  }
}

// Loaded only in US deployments
@Conditional(c => c.env('REGION', 'us'))
@Injectable()
@Extends()
class BraintreeUSGateway extends PaymentGateway {
  async charge(amount: number, currency: string) {
    // Braintree US endpoint
    return { transactionId: `us_${crypto.randomUUID()}` }
  }
  async refund(transactionId: string) {
    // refund via Braintree US
  }
}

// Used when no other gateway qualifies
@Conditional(c => c.missing(PaymentGateway))
@Injectable()
@Extends()
class MockPaymentGateway extends PaymentGateway {
  async charge(amount: number, currency: string) {
    console.warn('MockPaymentGateway: no real gateway for this region')
    return { transactionId: `mock_${crypto.randomUUID()}` }
  }
  async refund(transactionId: string) {}
}
```

### Consuming the gateway

```ts
@Injectable([PaymentGateway])
class CheckoutService {
  constructor(private readonly gateway: PaymentGateway) {}

  async checkout(amount: number, currency: string) {
    const result = await this.gateway.charge(amount, currency)
    return result.transactionId
  }
}
```

At runtime, exactly one gateway is registered: the one whose condition matches
`REGION`, or the mock when none does. `CheckoutService` receives whichever is active
without knowing which one.

---

## When conditions are decided

Every binding without conditions is registered first, whether by decorators, by hand or by a module. The bindings with
conditions are then decided when the container compiles:

1. A `present(key)` or `missing(key)` condition on a key a binding without conditions answers to is settled from the
   start, so it is decided first. A binding that fails one is dropped before any other of its conditions is checked.
2. `env` and `config` conditions are checked next, in the order they are written. They depend on no other binding.
   A binding that fails one is dropped.
3. Any other `present(key)` or `missing(key)` condition is decided after every other binding that could answer to
   `key`. So a default sees a conditional replacement whatever order the two were declared or bound in, and
   `present()` sees a binding a `missing()` default registers.
4. A `@Provides` method is decided after its `@Configuration` class, and is dropped with it, whatever else binds the
   class key. Once `rebind()` replaced the class, the method goes with the replacement instead. While the class waits
   on a condition of step 3, the method's `env` and `config` wait with it, and run only once the class registered.

Bindings that do not check each other keep the order they were declared in. A condition never sees its own binding,
nor the `@Provides` that go with it, so a `@Configuration` class that provides a key when `missing()` finds it unbound
registers on its own.

A `config` test runs before the `present()` and `missing()` conditions of step 3 are decided, even when one of them
would drop the binding. Write it so it does not depend on what they guard.

Bindings can wait for each other: two defaults of one key nothing else binds, or two bindings that each check the
other's key. Which one should register is not decidable, so `init()` fails with `ErrCircularCondition`, naming them.
Bind the key yourself, and neither has to wait.

A `@Provides` method of a class that waits counts as an answer to its key until the class is decided, whatever its own
`env` and `config` would say. Two `@Configuration` classes that each provide a key they check is `missing()` wait for
each other, even when the `env` of one of the methods fails.

---

## `@Profile` — named activation groups

For environment or persona-based groupings (`test`, `production`, `eu`), `@Profile`
is a declarative alternative to `@Conditional`. Instead of describing a condition,
you name the group on the binding and activate it at the container level.

See the [Profiles guide](./profiles.md) for full documentation.

**Quick comparison:**

|            | `@Profile`                                     | `@Conditional`                                     |
| ---------- | ---------------------------------------------- | -------------------------------------------------- |
| Activation | Container `profiles` option or `addProfiles()` | Conditions decided when the container compiles     |
| Style      | Name a group                                   | Check a binding, a setting or a variable           |
| Best for   | Environment / persona groupings                | Feature flags, presence checks, defaults, env vars |

---

## Stacking multiple conditions

Every condition must pass: several `@Conditional` decorators on the same class, or several conditions in one, are
ANDed.

```ts
// Only loaded in EU region AND when Redis is available
@Conditional(c => c.env('REGION', 'eu'))
@Conditional(c => c.present(RedisClient))
@Injectable([RedisClient])
class RedisEUCache {
  constructor(private readonly client: RedisClient) {}
  // ...
}

// The same, in one decorator
@Conditional(c => [c.env('REGION', 'eu'), c.present(RedisClient)])
@Injectable([RedisClient])
class RedisEUCacheToo {
  constructor(private readonly client: RedisClient) {}
  // ...
}
```

There is no built-in OR or negation. Model OR by splitting it into separate bindings, each with its own condition,
and a fallback by a `missing()` default. A rule that reads several settings at once belongs in a `config()` test.

---

## Reading configuration

`config()` tests the values bound with `bindConfig()`, the ones `$i.config` injects. Give `@Conditional` the
configuration type, so the test is typed:

```ts
type AppConfig = { payments: { newFlow: boolean } }

@Primary()
@Conditional<AppConfig>(c => c.config(cfg => cfg.payments.newFlow))
@Injectable()
@Extends()
class NewPaymentGateway extends PaymentGateway {
  // ...
}

const di = new CaffeineIoC()
di.bindConfig<AppConfig>({ payments: { newFlow: true } })
await di.init()
```

An application built with `@caffeinejs/std` binds its configuration for you.

- The test reads the values once, when the container compiles. A later reload of the configuration does not
  register or remove the binding.
- It must return a boolean. An async test, which returns a Promise, fails the compilation with `ErrInvalidBinding`, as
  does a test that throws.
- It runs after the binding's `present()` and `missing()` conditions on a key a binding without conditions answers
  to, and before the others are decided. See [When conditions are decided](#when-conditions-are-decided).
- On a `@Provides` method, it never runs when the `@Configuration` class fails, and waits for the class to register
  while the class waits on a `present()` or `missing()` condition.
- Without values bound, compiling fails with `ErrNoValuesProvider`.

---

## Environment variables

`env(name)` passes when the variable is set, an empty value included. `env(name, expected)` passes when it equals
`expected`.

```ts
// Only when SMTP_HOST is set
@Conditional(c => c.env('SMTP_HOST'))
@Injectable()
@Extends()
class SmtpMailer extends Mailer {
  // ...
}
```

The variable is read when the container compiles, not when the decorator is applied, so a value set before `init()`
is the one that counts. Where there is no `process`, as in a browser, every variable reads as unset.

---

## Conditional `@Configuration` classes

`@Conditional` can be applied to a `@Configuration` class. When the class-level
condition fails, **all** `@Provides` methods inside that class are skipped — they
are treated as if they were never declared.

```ts
import { Configuration, Provides, Conditional } from '@caffeinejs/di'

@Configuration()
@Conditional(c => c.env('REGION', 'eu'))
class EUInfrastructureConfig {
  // Always provided when the class condition passes
  @Provides(PaymentGateway)
  gateway() {
    return new StripeEUGateway()
  }

  // Only provided in EU AND when Redis is available
  @Conditional(c => c.present(RedisClient))
  @Provides(CacheStore)
  cache(client: RedisClient) {
    return new RedisEUCache(client)
  }

  // Only provided in EU AND when the tax service is configured
  @Conditional(c => c.env('TAX_SERVICE_URL'))
  @Provides(TaxCalculator)
  taxCalc() {
    return new EUTaxCalculator()
  }
}
```

Each method's effective condition is the AND of the class-level and method-level
conditions. In the example above:

- `gateway` is provided whenever `REGION` is `eu`
- `cache` is provided when `REGION` is `eu` AND `RedisClient` is bound
- `taxCalc` is provided when `REGION` is `eu` AND `TAX_SERVICE_URL` is set

When the class fails any of its conditions, its methods are dropped with it, and none of their conditions is decided.
While the class waits on a `present()` or `missing()` condition, their `env` and `config` wait with it.

The methods go with the class, not with its key: a binding of the class key made by hand, with conditions or without,
does not keep them when the class fails. `rebind()` replaces the class, conditions included. Its methods then go with
the replacement, and are called on it.

---

## Manual bindings with `.conditional()`

The fluent binder exposes `.conditional()` for the same behaviour without decorators. It takes the same arguments as
`@Conditional`.

```ts
import { CaffeineIoC } from '@caffeinejs/di'

const di = new CaffeineIoC({ decorators: false })

di.bind(StripeEUGateway, t =>
  t
    .toSelf()
    .extends(PaymentGateway)
    .conditional(c => c.env('REGION', 'eu')),
)

di.bind(BraintreeUSGateway, t =>
  t
    .toSelf()
    .extends(PaymentGateway)
    .conditional(c => c.env('REGION', 'us')),
)

di.bind(MockPaymentGateway, t =>
  t
    .toSelf()
    .extends(PaymentGateway)
    .conditional(c => c.missing(PaymentGateway)),
)

await di.init()
```

Multiple `.conditional()` calls chain as AND, matching the decorator behaviour.

A binding made by hand with `.conditional()` is decided when the container compiles, the way a decorated one is. A
key takes one binding: if its conditions pass while another binding holds its key, `init()` fails with
`ErrDuplicateBinding`. `rebind()` of the same key discards it.

---

## Defaults

A default is an implementation used only when nothing else provides the key. Give it a
`missing()` condition on that key:

```ts
// Ships with the library — yields to any other Cache
@Conditional(c => c.missing(Cache))
@Injectable()
@Extends()
class InMemoryCache extends Cache {
  // ...
}
```

The same condition works on a binding made by hand, which is how a feature ships a default
from its configuration step:

```ts
di.bind(Cache, t => t.toClass(InMemoryCache).conditional(c => c.missing(Cache)))
```

It yields to every other binding of `Cache`, conditional or not, whether bound by hand
before or after it, by a module or by decorators: it is decided after all of them.

Two defaults of one key that nothing else binds wait for each other, and `init()` fails
with `ErrCircularCondition`. An application that binds the key itself settles them.

A default can also stay unconditional, with the replacement marked `@Primary`:

```ts
@Primary()
@Conditional(c => c.present(RedisClient))
@Injectable([RedisClient])
@Extends()
class RedisCache extends Cache {
  // ...
}
```

Both are registered then, and `Cache` resolves to `RedisCache` whenever it is registered.
