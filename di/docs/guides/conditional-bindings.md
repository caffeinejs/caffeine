# Conditionals

`@ConditionalOn` registers a binding only when a predicate returns `true` at
container initialization. The predicate is evaluated once during `init()` — bindings
that fail their condition are never added to the container.

This is the primary tool for environment-driven wiring: selecting the right
implementation based on a region, a feature flag, the presence of another binding,
or any runtime condition you can express as a boolean.

---

## How `@ConditionalOn` works

```ts
import { ConditionalOn } from '@caffeinejs/di'
```

The decorator takes a `Conditional` — a function receiving a `ConditionContext`
and returning `boolean` or `Promise<boolean>`.

```ts
type Conditional = (ctx: ConditionContext) => boolean | Promise<boolean>

interface ConditionContext {
  container: { has(key: InjectionToken): boolean }
  key: InjectionToken
  binding: BindingDecoratorConfig
}
```

| `ctx` field          | Description                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `container.has(key)` | Whether another binding is registered. Safe to call — all bindings are collected before any predicate runs. |
| `key`                | The key of the binding being tested.                                                                        |
| `binding`            | Decorator config (scope, name, labels) of the binding being tested.                                         |

Predicate evaluation order: all bindings are registered first, then predicates are
evaluated during `init()`. This means `ctx.container.has()` can safely check for
any key — including ones registered in modules or manually.

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
import { Injectable, Extends, Fallback, ConditionalOn } from '@caffeinejs/di'
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
@ConditionalOn(() => process.env.REGION === 'eu')
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
@ConditionalOn(() => process.env.REGION === 'us')
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

// Optional fallback — used only when no other gateway qualifies
@Fallback()
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

At runtime, exactly one gateway is registered — the one whose condition matches
`REGION`. `CheckoutService` receives whichever is active without knowing which one.

---

## `@Profile` — named activation groups

For environment or persona-based groupings (`test`, `production`, `eu`), `@Profile`
is a declarative alternative to `@ConditionalOn`. Instead of writing a predicate,
you name the group on the binding and activate it at the container level.

See the [Profiles guide](./profiles.md) for full documentation.

**Quick comparison:**

|               | `@Profile`                                     | `@ConditionalOn`                         |
| ------------- | ---------------------------------------------- | ---------------------------------------- |
| Activation    | Container `profiles` option or `addProfiles()` | Arbitrary predicate at init time         |
| Style         | Declarative — name a group                     | Imperative — write a function            |
| Async support | No                                             | Yes                                      |
| Best for      | Environment / persona groupings                | Feature flags, presence checks, env vars |

---

## Stacking multiple conditions

Multiple `@ConditionalOn` decorators on the same class are ANDed — **all** must
return `true` for the binding to be registered.

```ts
// Only loaded in EU region AND when Redis is available
@ConditionalOn(() => process.env.REGION === 'eu')
@ConditionalOn(ctx => ctx.container.has(RedisClient))
@Injectable([RedisClient])
class RedisEUCache {
  constructor(private readonly client: RedisClient) {}
  // ...
}
```

There is no built-in OR. Model OR logic by splitting it into separate bindings, each
with its own condition, or by combining multiple checks inside a single predicate.

---

## Async conditionals

The predicate can return a `Promise<boolean>`, which is awaited during `init()`.
Useful for feature flags fetched from a remote service.

```ts
import type { Conditional } from '@caffeinejs/di'

// featureFlags() is a standalone async function — ctx.container has no .get()
const isNewPaymentFlowEnabled: Conditional = async () => {
  const flags = await featureFlags()
  return flags.isEnabled('new-payment-flow')
}

@ConditionalOn(isNewPaymentFlowEnabled)
@Injectable()
@Extends()
class NewPaymentGateway extends PaymentGateway {
  // ...
}
```

A common synchronous variant — conditionally activate a binding in test environments:

```ts
@ConditionalOn(() => process.env.NODE_ENV === 'test')
@Injectable()
@Extends()
class StubPaymentGateway extends PaymentGateway {
  async charge(amount: number, currency: string) {
    return { transactionId: 'test_txn_001' }
  }
  async refund(transactionId: string) {}
}
```

All async predicates run concurrently inside `init()`. Order of evaluation is not
guaranteed — predicates must not depend on each other's side effects.

---

## Conditional `@Configuration` classes

`@ConditionalOn` can be applied to a `@Configuration` class. When the class-level
condition fails, **all** `@Provides` methods inside that class are skipped — they
are treated as if they were never declared.

```ts
import { Configuration, Provides, ConditionalOn } from '@caffeinejs/di'

@Configuration()
@ConditionalOn(() => process.env.REGION === 'eu')
class EUInfrastructureConfig {
  // Always provided when the class condition passes
  @Provides(PaymentGateway)
  gateway() {
    return new StripeEUGateway()
  }

  // Only provided in EU AND when Redis is available
  @ConditionalOn(ctx => ctx.container.has(RedisClient))
  @Provides(CacheStore)
  cache(client: RedisClient) {
    return new RedisEUCache(client)
  }

  // Only provided in EU AND outside test environments
  @ConditionalOn(() => process.env.NODE_ENV !== 'test')
  @Provides(TaxCalculator)
  taxCalc() {
    return new EUTaxCalculator()
  }
}
```

Each method's effective condition is the AND of the class-level and method-level
predicates. In the example above:

- `gateway` is provided whenever `REGION === 'eu'`
- `cache` is provided when `REGION === 'eu'` AND `RedisClient` is bound
- `taxCalc` is provided when `REGION === 'eu'` AND `NODE_ENV !== 'test'`

When the class-level condition fails entirely, none of the methods are evaluated —
including the method-level predicates.

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
    .conditional(() => process.env.REGION === 'eu'),
)

di.bind(BraintreeUSGateway, t =>
  t
    .toSelf()
    .extends(PaymentGateway)
    .conditional(() => process.env.REGION === 'us'),
)

di.bind(MockPaymentGateway, t => t.toSelf().extends(PaymentGateway).fallback())

await di.init()
```

Multiple `.conditional()` calls chain as AND, matching the decorator behaviour.
