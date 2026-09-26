# Profiles

Profiles are named activation groups. A binding decorated with `@Profile` or
configured with `.profiles()` is only registered when one of those profiles is
in the container's active set — via the `profiles` constructor option or
`addProfiles()` before `compile()` / `init()`.

A profile is a condition: `@Profile('test')` is shorthand for
`@Conditional(c => c.profile('test'))`, and `.profiles('test')` for
`.conditional(c => c.profile('test'))`. A profiled binding is held back until the
container compiles, like any conditional one — even when its profile is active from
the start — and decided there with the other conditions. Until then `has()`,
`entries()` and `size` do not see it.

Bindings without any profile restriction are always registered, regardless of
which profiles are active — the same semantics Docker Compose uses for its
profiles.

```ts
import { Profile } from '@caffeinejs/di'
```

:::tip
For activation logic that cannot be expressed as a simple name — feature flags fetched
at runtime, presence of another binding, environment variable comparisons — use
[`@Conditional`](./conditional-bindings.md) with another condition. See the end of this
page for combining the two.
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

Activate profiles when constructing the container, or later with `addProfiles()`
as long as the container has not been compiled:

```ts
const di = new CaffeineIoC({ profiles: ['test'] })
await di.init()

di.get(StubPaymentGateway) // resolves — 'test' is active
di.get(StripeEUGateway) // resolves — no profile, always active
```

```ts
const di = new CaffeineIoC()
di.addProfiles('test')
await di.init()
```

When no profiles are active, only no-profile bindings are registered:

```ts
const di = new CaffeineIoC()
await di.init()

di.get(StripeEUGateway) // resolves
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

Two stacked `@Profile` decorators are two conditions, and both must pass, like any
stacked conditions:

```ts
@Profile('eu')
@Profile('production')
@Injectable()
class EUProductionAuditLog extends AuditLog {
  // registered only when 'eu' AND 'production' are both active
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
skipped unless the profile is active — the same cascade as any condition on a
configuration class. The class is decided first and its methods wait for it, so the
order the class decorators are written in does not matter.

```ts
import { Configuration, Provides, Profile } from '@caffeinejs/di'

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

## Fluent `.profiles()`

Manual bindings use the same semantics as `@Profile`: the names given to one call are
alternatives, and two calls must both pass.

```ts
di.bind(StubPaymentGateway, t => t.toSelf().profiles('test', 'development'))
```

---

## Profiles and other conditions

A profile is one of the conditions [`@Conditional`](./conditional-bindings.md) takes.
Use `@Profile` when a binding naturally belongs to a named environment or persona
(`test`, `production`, `eu`, `staging`). Use another condition when activation depends
on something else: whether another binding is present, the configuration, an
environment variable, or a flag fetched from a remote service.

The two combine like any conditions — `@Profile` and `@Conditional` on the same class
are ANDed: the binding is registered only when the profile is active **and** the other
condition passes. The profile is checked first.

```ts
// Only in 'eu' profile AND only when RedisClient is bound
@Profile('eu')
@Conditional(c => c.present(RedisClient))
@Injectable()
class RedisEUCache extends CacheStore {
  /* ... */
}
```
