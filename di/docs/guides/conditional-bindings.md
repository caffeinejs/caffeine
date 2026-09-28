# Conditionals

`@Conditional` registers a binding only when its condition passes. The container decides every condition once,
during `init()`: a binding that fails its condition is never added to the container.

This is the primary tool for environment-driven wiring: selecting the right implementation based on a region, a
configuration value, a feature flag, or the presence of another binding.

---

## How `@Conditional` works

```ts
import { $cond, Conditional } from '@caffeinejs/di'
```

A condition is data, built with `$cond`. Each kind reads one thing:

| Condition                         | Passes when                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------ |
| `$cond.present(key)`              | a binding answers to `key`: one registered under it, named after it, or extending it       |
| `$cond.missing(key)`              | no binding answers to `key`                                                                |
| `$cond.config(access, expected?)` | the value the values provider holds at `access` equals `expected`, or is `true` without it |
| `$cond.env(name, expected?)`      | the environment variable is set to a non-empty value, or equals `expected`                 |
| `$cond.when(test)`                | `test()` returns `true`; it may be async                                                   |

`@Conditional` and `.conditional()` take a condition, or a callback handed the same builders — the form that needs
no import:

```ts
@Conditional($cond.env('REGION', 'eu'))
@Injectable()
class StripeEUGateway {}

// The same condition, without importing $cond
@Conditional(c => c.env('REGION', 'eu'))
@Injectable()
class StripeEUInvoices {}
```

The callback runs once, when the class is decorated, and must return a condition. A predicate is not one: wrap it in
`c.when(() => ...)`. The test is handed nothing — whether a key is bound is asked with `present` or `missing`.

`present` and `missing` never count the binding being decided, so a binding can neither satisfy nor defeat its own
condition.

Decision order: every binding without conditions is registered first — by hand, by a module or by decorators.
Bindings with conditions are then decided one at a time during `init()`. A `present` or `missing` condition waits for
every other binding held for its conditions that answers to its key — registered under it, named after it, or
extending it — and a `config` condition waits for a held values provider. Otherwise the order is the order of
declaration: decorated `@Configuration` classes first, each followed by its own `@Provides`, together with the
conditional `@Provides` of unconditional classes, then the other decorated bindings in the order they were declared,
then the ones bound by hand in the order they were bound. So `present` and `missing` see every binding that could
answer to their key, conditional ones included.

Two bindings can wait for each other, as two defaults of one key do. Such a cycle is decided in declaration order: the
first binding on it is decided as if the others were absent, and no decision is revisited. Two defaults of one key
settle that way. A cycle of `missing` conditions across different keys can leave a binding registered whose condition
no longer holds, so keep such conditions from depending on each other.

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

// Used when no other gateway qualifies — the complement of the conditions above
@Conditional(c => c.when(() => !['eu', 'us'].includes(process.env.REGION ?? '')))
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

`c.env` reads the variable when the container compiles, not when the class is decorated, so the environment can be
set up to the moment `init()` runs.

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

At runtime, exactly one gateway is registered — the one whose condition matches
`REGION`. `CheckoutService` receives whichever is active without knowing which one.

---

## Configuration-driven implementations

`c.config` reads the values provider, the same one `$i.value` injects from, and takes the same access: a
dot-separated path or a selector.

```ts
type AppConfig = { cache: { kind: 'redis' | 'memory'; warmup: boolean } }

di.bindValuesProvider<AppConfig>(t => t.toValue(config))

di.bind(Cache, t => t.toClass(RedisCache).conditional(c => c.config('cache.kind', 'redis')))
di.bind(Cache, t => t.toClass(MemoryCache).conditional(c => c.config('cache.kind', 'memory')))

// Without an expected value, the condition is a switch: it passes on `true` only
di.bind(CacheWarmer, t => t.toSelf().conditional(c => c.config('cache.warmup')))

// A selector is typed against the configuration it reads
di.bind(Cache, t => t.toClass(RedisCache).conditional(c => c.config<AppConfig>(cfg => cfg.cache.kind, 'redis')))
```

The provider is read when the container compiles, before anything can be resolved, so it must be bound with
`toValue()`, or with `toFactory()` and no injections. The provider `@caffeinejs/std` binds for an application
qualifies. With no provider bound, `init()` throws `ErrNoValuesProvider`.

---

## `@Profile` — named activation groups

For environment or persona-based groupings (`test`, `production`, `eu`), `@Profile`
is a declarative alternative to `@Conditional`. Instead of writing a condition,
you name the group on the binding and activate it at the container level.

See the [Profiles guide](./profiles.md) for full documentation.

**Quick comparison:**

|               | `@Profile`                                     | `@Conditional`                                  |
| ------------- | ---------------------------------------------- | ----------------------------------------------- |
| Activation    | Container `profiles` option or `addProfiles()` | A condition decided at init time                |
| Style         | Declarative — name a group                     | A condition built with `$cond`                  |
| Async support | No                                             | Yes, through `c.when`                           |
| Best for      | Environment / persona groupings                | Configuration, env vars, presence checks, flags |

A profile is not a condition kind. `@Profile` is decided when the binding registers, and combines with
`@Conditional` as AND.

---

## Stacking multiple conditions

Multiple `@Conditional` decorators on the same class are ANDed — **all** must
pass for the binding to be registered.

```ts
// Only loaded in EU region AND when Redis is available
@Conditional(c => c.env('REGION', 'eu'))
@Conditional(c => c.present(RedisClient))
@Injectable([RedisClient])
class RedisEUCache {
  constructor(private readonly client: RedisClient) {}
  // ...
}
```

There is no built-in OR. Model OR logic by splitting it into separate bindings, each
with its own condition, or by combining multiple checks inside a single `c.when` test.

---

## Async conditions

A `when` test can return a `Promise<boolean>`, which is awaited during `init()`.
Useful for feature flags fetched from a remote service.

```ts
const isNewPaymentFlowEnabled = async () => {
  const flags = await featureFlags()
  return flags.isEnabled('new-payment-flow')
}

@Conditional(c => c.when(isNewPaymentFlowEnabled))
@Injectable()
@Extends()
class NewPaymentGateway extends PaymentGateway {
  // ...
}
```

A common synchronous variant — conditionally activate a binding in test environments:

```ts
@Conditional(c => c.env('NODE_ENV', 'test'))
@Injectable()
@Extends()
class StubPaymentGateway extends PaymentGateway {
  async charge(amount: number, currency: string) {
    return { transactionId: 'test_txn_001' }
  }
  async refund(transactionId: string) {}
}
```

Conditions are decided one at a time, in the order described in
[How `@Conditional` works](#how-conditional-works). A `when` test must not depend on
another's side effects.

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

  // Only provided in EU AND outside test environments
  @Conditional(c => c.when(() => process.env.NODE_ENV !== 'test'))
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
- `taxCalc` is provided when `REGION` is `eu` AND `NODE_ENV` is not `test`

When the class-level condition fails entirely, none of the methods are evaluated —
including the method-level conditions.

---

## Manual bindings with `.conditional()`

The fluent binder exposes `.conditional()` for the same behaviour without decorators.

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
    .conditional(c => c.when(() => !['eu', 'us'].includes(process.env.REGION ?? ''))),
)

await di.init()
```

Multiple `.conditional()` calls chain as AND, matching the decorator behaviour, and so do several conditions given
at once: `.conditional([$cond.env('REGION', 'eu'), $cond.present(RedisClient)])`.

A binding made by hand with `.conditional()` waits for `init()` the way a decorated one does.
Until then `has()` does not see it, and it leaves a binding already registered under its key
alone. It replaces that binding only if its condition passes, and never a conditional decorated
one — see [Clashes](#clashes). Binding the same key again discards it, the same way the second
of two `bind()` calls replaces the first.

---

## Clashes

A binding decided at `init()` never silently replaces another binding of its key. `init()` throws
`ErrRepeatedInjectableConfiguration` when:

- a decorated binding whose condition passes meets any binding already registered under its key —
  made by hand, by a module, or by decorators;
- a binding made by hand with `.conditional()` passes where a conditional decorated binding of its key
  passed too, whichever of the two is decided first.

`bind()` of a decorated class starts from its decorators, conditions included, so binding a conditional
decorated class by hand clashes with it when the condition passes. Replace a decorated binding with
`rebind()`:

```ts
di.rebind(RedisCache, t => t.toClass(FakeRedisCache))
```

A binding made by hand still replaces another one made by hand, one a module made, and a decorated one
registered when the container was built, as `bind()` always has. Conditions that exclude each other never
clash, since only one of the bindings passes.

---

## Defaults

A default is an implementation used only when nothing else provides the key. Give it a
condition that checks for that:

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

It yields to every other binding of `Cache`, with conditions or without, whether bound by hand
before or after it, by a module or by decorators: its condition is decided after every binding
that answers to `Cache`. When the replacement's own condition fails, the default registers. Of
two defaults of one key, the first declared registers and the other yields to it.

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
