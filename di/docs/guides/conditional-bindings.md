# Conditionals

`@Conditional` registers a binding only when its condition passes. The container decides it once, when it compiles
during `init()` — a binding that fails its condition is never added to the container.

This is the primary tool for environment-driven wiring: selecting the right implementation based on a region, a
feature flag, the configuration, the presence of another binding, or anything else you can check at start-up.

---

## Conditions

```ts
import { Conditional } from '@caffeinejs/di'
```

A condition is data, not a function. You build it with a helper, most often in a callback that is handed the helpers:

```ts
@Conditional(c => c.missing(Cache))
@Injectable()
@Extends()
class InMemoryCache extends Cache {}
```

| Helper                       | Passes when                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `c.present(key)`             | Something answers to the key: a binding registered under it, one named after it, or one extending it. |
| `c.missing(key)`             | Nothing answers to the key. This is how a [default](#defaults) is written.                            |
| `c.profile(name, ...names)`  | Any of the named profiles is active. `@Profile` is shorthand for it.                                  |
| `c.config(access)`           | The value read through the config provider is `true`.                                                 |
| `c.config(access, expected)` | The value read through the config provider equals `expected`.                                         |
| `c.env(name)`                | The environment variable is set to a non-empty value.                                                 |
| `c.env(name, expected)`      | The environment variable equals `expected`.                                                           |
| `c.when(test)`               | `test()` returns `true`. It may be async, and it is handed nothing — the container included.          |

The same helpers are exported as `$cond`, for a condition built ahead of time and shared by several bindings:

```ts
import { $cond } from '@caffeinejs/di'

const onRedis = $cond.config<AppConfig>(c => c.cache.kind, 'redis')

di.bind(Cache, t => t.toClass(RedisCache).conditional(onRedis))
di.bind(Lock, t => t.toClass(RedisLock).conditional(onRedis))
```

A callback runs once, when the class is decorated or `.conditional()` is called. What the binding holds is the
condition it returned.

---

## When a condition is decided

A binding carrying a condition is held back until the container compiles, whether it is decorated or bound by hand.
Until then `has()`, `entries()`, `size` and `getBindingsByLabel()` do not see it.

At compile time, the held bindings are decided in **dependency order**: a binding whose condition checks for a key is
decided after every held binding that answers to that key — by the key itself, a name, or a base. A `config` condition
waits for a held config provider. So the order bindings were declared or bound in does not change the outcome:

```ts
// Declared first, and still decided after RedisStore: its condition checks for Store, which RedisStore answers to.
@Conditional(c => c.missing(Store))
@Injectable()
@Extends()
class MemoryStore extends Store {}

@Conditional(c => c.env('STORE', 'redis'))
@Injectable()
@Extends()
class RedisStore extends Store {}
```

Among the bindings free to be decided, the first declared goes first. When none is — two defaults of one key each wait
for the other — the first declared goes first, and the other then sees it.

A cycle settles only when some outcome of it holds together. When none does — `Rock` checks `c.missing(Paper)`, `Paper`
checks `c.missing(Scissors)`, and `Scissors` checks `c.missing(Rock)` — `init()` fails with `ErrInvalidBinding`, naming
the binding whose condition the rest of the cycle proved false, rather than keep it registered.

Within one binding, profiles are checked first and `c.when` predicates last, so a predicate of your own runs only once
every condition the container can check itself has passed.

A binding with conditions made while the container decides them — from a `c.when` predicate, a hook, or the config
provider — could be ordered against none of the bindings already decided, so `init()` refuses it with
`ErrInvalidContainerState`. A binding without conditions made there registers as it would anywhere else.

When a condition throws, `init()` rejects with that error. The bindings decided before it stay decided, and calling
`init()` again decides only the rest.

:::warning
A binding that fails its condition is completely absent from the container. Any hard injection of that key will throw
`ErrNoResolutionForKey`. Use `optional()` for dependencies that may not be present.
:::

---

## Region-based implementations

A realistic pattern: different infrastructure implementations are loaded based on a `REGION` environment variable. One
abstract base defines the contract; each region-specific class registers only when its region matches.

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

At runtime, exactly one gateway is registered — the one whose condition matches `REGION`, or the mock when none does.
`CheckoutService` receives whichever is active without knowing which one.

---

## Profiles

A profile is a condition that checks the container's active profiles. `@Profile('eu')` is shorthand for
`@Conditional(c => c.profile('eu'))`, and `.profiles('eu')` for `.conditional(c => c.profile('eu'))`. Profiles are
decided with the other conditions, in the same pass.

See the [Profiles guide](./profiles.md) for full documentation.

---

## Stacking multiple conditions

Multiple `@Conditional` decorators on the same class are ANDed — **all** must pass for the binding to be registered.

```ts
// Only loaded in the EU region AND when Redis is available
@Conditional(c => c.env('REGION', 'eu'))
@Conditional(c => c.present(RedisClient))
@Injectable([RedisClient])
class RedisEUCache {
  constructor(private readonly client: RedisClient) {}
  // ...
}
```

There is no built-in OR. Model it by splitting it into separate bindings, each with its own condition, or check both
alternatives inside one `c.when` predicate.

---

## Predicates of your own

`c.when` takes any predicate, sync or async. The container awaits it while it compiles, which suits a feature flag
fetched from a remote service:

```ts
@Conditional(c => c.when(async () => (await featureFlags()).isEnabled('new-payment-flow')))
@Injectable()
@Extends()
class NewPaymentGateway extends PaymentGateway {
  // ...
}
```

The predicate is handed nothing. Whether a key is bound is asked with `c.present` or `c.missing`: the container orders
those, and cannot know what an arbitrary function reads.

---

## Reading the configuration

`c.config` reads through the container's config provider — the one `$i.config` injections read — with the same
selector or dot-separated path:

```ts
@Conditional(c => c.config('cache.enabled'))
@Injectable()
class CacheWarmer {}

@Conditional(c => c.config<AppConfig, string>(cfg => cfg.cache.kind, 'redis'))
@Injectable()
@Extends()
class RedisCache extends Cache {}
```

The provider is read once, while the container compiles, so a reload afterwards does not decide the binding again.
Because nothing is compiled yet at that point, it must be bound with `toValue()` or `toFactory()`; an application built
with `@caffeinejs/std` has one already. With no provider bound, the container fails with `ErrNoConfigProvider`.

---

## Conditional `@Configuration` classes

A condition on a `@Configuration` class covers its `@Provides` methods too: when the class fails its condition, **all**
of them are skipped — as if they were never declared.

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

Each method's effective condition is the AND of the class-level and method-level conditions. In the example above:

- `gateway` is provided whenever `REGION === 'eu'`
- `cache` is provided when `REGION === 'eu'` AND `RedisClient` is bound
- `taxCalc` is provided when `REGION === 'eu'` AND `NODE_ENV !== 'test'`

The class is decided before its methods. When it fails, none of the methods are evaluated — method-level conditions
included. A `@Provides` method belongs to its own class: another class providing the same key does not share its fate.

---

## Manual bindings with `.conditional()`

The fluent binder exposes `.conditional()` for the same behaviour without decorators. It takes a callback, a condition,
or several conditions.

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

A binding made by hand with `.conditional()` is held back until `init()` the way a decorated one is, and leaves a
binding of its key alone — registered, or held back beside it. It replaces that binding only if its conditions pass, so
a key can be bound once for each profile:

```ts
di.bind(Storage, t => t.toClass(LocalDiskStorage).profiles('dev'))
di.bind(Storage, t => t.toClass(S3Storage).profiles('prod'))
```

When more than one of them passes, the one decided last is registered, as the second of two `bind()` calls replaces the
first. Binding the key again without conditions discards every one of them.

---

## Defaults

A default is an implementation used only when nothing else provides the key. Give it a condition that checks for that:

```ts
// Ships with the library — yields to any other Cache
@Conditional(c => c.missing(Cache))
@Injectable()
@Extends()
class InMemoryCache extends Cache {
  // ...
}
```

The same condition works on a binding made by hand, which is how a feature ships a default from its configuration step:

```ts
di.bind(Cache, t => t.toClass(InMemoryCache).conditional(c => c.missing(Cache)))
```

It yields to every other binding of `Cache` — bound by hand before or after it, by a module or by decorators,
conditional or not. A conditional one is decided before the default, whichever was declared first.

A `@Configuration` class can be a default for what it provides: its condition does not wait for its own `@Provides`
methods.

```ts
@Configuration()
@Conditional(c => c.missing(DataSource))
class EmbeddedDataSourceConfig {
  @Provides(DataSource)
  dataSource() {
    return new EmbeddedDataSource()
  }
}
```

---

## When two bindings claim one key

A decorated binding decided at compile time never replaces a binding registered under its key. When both pass, the
container fails with `ErrRepeatedInjectableConfiguration` — whichever of the two is decided second, and whether the
other one was bound by hand or declared by another class. Two unconditional `@Provides` of one key fail the same way.

Two ways out:

- `rebind(key, …)` replaces the decorated binding, and drops it before it is decided.
- `c.missing(key)` on one of them makes it a default that yields to the other.
