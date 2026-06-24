# Profiles

Profiles are named activation groups. A binding decorated with `@Profile` is only
registered when that profile is listed in the container's `profiles` option at
construction time.

Bindings without any `@Profile` are always registered, regardless of which profiles
are active — the same semantics Docker Compose uses for its profiles.

```ts
import { Profile } from '@caffeinejs/core/decorators'
```

:::tip
For activation logic that cannot be expressed as a simple name — feature flags fetched
at runtime, presence of another binding, environment variable comparisons — use
[`@ConditionalOn`](./conditional-bindings.md) instead. See the comparison table at the
end of this page.
:::

---

## Basic usage

```ts
@Injectable()
@Extends()
class StripeEUGateway extends PaymentGateway {
  // always registered — no profile restriction
}

@Profile('test')
@Injectable()
@Extends()
class StubPaymentGateway extends PaymentGateway {
  // registered only when the 'test' profile is active
  async charge(amount: number, currency: string) {
    return { transactionId: 'test_txn_001' }
  }
  async refund(transactionId: string) {}
}
```

Activate profiles when constructing the container:

```ts
const di = new CaffeineIoC({ profiles: ['test'] })
await di.init()

di.get(StubPaymentGateway) // resolves — 'test' is active
di.get(StripeEUGateway)    // resolves — no profile, always active
```

When no profiles are active, only no-profile bindings are registered:

```ts
const di = new CaffeineIoC()
await di.init()

di.get(StripeEUGateway)    // resolves
di.get(StubPaymentGateway) // throws ErrNoResolutionForKey — 'test' not active
```

---

## Multiple profiles on one decorator

Pass multiple profile names to `@Profile` — the binding is registered when **any**
of them is active (OR semantics):

```ts
@Profile('development', 'staging')
@Injectable()
class VerboseLogger extends Logger {
  // registered in development OR staging, not in production
}
```

---

## Activating multiple profiles simultaneously

Pass multiple profile names to the container. All listed profiles are active at once:

```ts
const di = new CaffeineIoC({ profiles: ['eu', 'test'] })
await di.init()
// bindings tagged @Profile('eu'), @Profile('test'), or @Profile('eu', 'test') are all active
```

---

## `@Profile` on a `@Configuration` class

When `@Profile` is on a `@Configuration` class, all `@Provides` methods inside are
skipped unless the profile is active — the same cascade behaviour as `@ConditionalOn`
on a configuration class.

```ts
import { Configuration, Provides, Profile } from '@caffeinejs/core/decorators'

@Configuration()
@Profile('test')
class TestInfrastructureConfig {
  @Provides(PaymentGateway)
  gateway() {
    return new StubPaymentGateway()
  }

  @Provides(EmailService)
  email() {
    return new NoopEmailService()
  }
}
```

Activate the profile in test runs to wire in the full stub infrastructure in one place:

```ts
// vitest setup file
const di = new CaffeineIoC({ profiles: ['test'] })
await di.init()
```

---

## `@Profile` vs `@ConditionalOn`

Both mechanisms control whether a binding is registered at `init()` time. The right
choice depends on what drives the decision.

| | `@Profile` | `@ConditionalOn` |
|---|---|---|
| Activation | Container `profiles` option | Arbitrary predicate at init time |
| Style | Declarative — name a group | Imperative — write a function |
| Async support | No | Yes |
| Best for | Environment / persona groupings | Feature flags, presence checks, env vars |

Use `@Profile` when a binding naturally belongs to a named environment or persona
(`test`, `production`, `eu`, `staging`). The profile name is the complete activation
condition — no predicate needed.

Use [`@ConditionalOn`](./conditional-bindings.md) when activation depends on runtime
state: whether another binding is present, the value of an env var, or a flag fetched
from a remote service.

The two can be combined — `@Profile` and `@ConditionalOn` on the same class are ANDed:
the binding is registered only when the profile is active **and** the predicate returns
`true`.

```ts
// Only in 'eu' profile AND only when RedisClient is bound
@Profile('eu')
@ConditionalOn(ctx => ctx.container.has(RedisClient))
@Injectable()
class RedisEUCache extends CacheStore { /* ... */ }
```
