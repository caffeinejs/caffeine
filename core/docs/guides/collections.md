---
sidebar_label: Collections
---

# Collections

DiCaf can inject multiple bindings registered under the same key into a single
dependency — either as an **array** with `allOf()`, or as a **`Map`** with `mapped()`.
Both functions are imported from the core package.

```ts
import { allOf, mapped } from '@caffeine-projects/dicaf'
```

This is useful when you register several implementations of the same abstract class or
symbol token and want a consumer to receive all of them at once.

---

## Array injection with `allOf`

`allOf(key)` collects every binding registered under `key` and injects them as an array.
The order of elements matches the registration order of the bindings.

### Example: validation pipeline

```ts
import { Injectable } from '@caffeine-projects/dicaf/decorators'
import { allOf } from '@caffeine-projects/dicaf'

abstract class Validator {
  abstract validate(value: unknown): string[]
}

@Injectable()
@Extends()
class RequiredValidator extends Validator {
  validate(value: unknown): string[] {
    return value == null ? ['Value is required'] : []
  }
}

@Injectable()
@Extends()
class LengthValidator extends Validator {
  validate(value: unknown): string[] {
    return typeof value === 'string' && value.length > 255 ? ['Value is too long'] : []
  }
}

@Injectable([allOf(Validator)])
class ValidationPipeline {
  constructor(private readonly validators: Validator[]) {}

  run(value: unknown): string[] {
    return this.validators.flatMap(v => v.validate(value))
  }
}
```

`allOf` also accepts an `InjectionDescriptor` instead of a plain key, so you can
compose it with other injection functions:

```ts
// Optional: resolve to an empty array when no bindings are registered
@Injectable([allOf(optional(Plugin))])
class PluginHost {
  constructor(private readonly plugins: Plugin[]) {}
}
```

---

## Map injection with `mapped`

`mapped(key)` collects every binding registered under `key` and injects them as a
`Map<string, T>`, where the map key is the binding's `@Named` value and the map value
is the resolved instance.

### Example: named strategy map

```ts
import { Injectable, Named } from '@caffeine-projects/dicaf/decorators'
import { mapped } from '@caffeine-projects/dicaf'

interface PaymentGateway {
  charge(amount: number): void
}

const kGateway = Symbol('app:gateway')

@Injectable(kGateway)
@Named('stripe')
class StripeGateway implements PaymentGateway {
  charge(amount: number) { /* ... */ }
}

@Injectable(kGateway)
@Named('paypal')
class PayPalGateway implements PaymentGateway {
  charge(amount: number) { /* ... */ }
}

@Injectable([mapped(kGateway)])
class PaymentService {
  constructor(private readonly gateways: Map<string, PaymentGateway>) {}

  pay(provider: string, amount: number) {
    const gateway = this.gateways.get(provider)
    if (!gateway) throw new Error(`Unknown provider: ${provider}`)
    gateway.charge(amount)
  }
}

// paymentService.gateways => Map { 'stripe' → StripeGateway, 'paypal' → PayPalGateway }
```

:::note
`mapped` requires each binding under the key to carry a `@Named` name. Bindings
without a name are not included in the resulting map.
:::

---

## Plain configuration

Both `allOf` and `mapped` work identically without decorators. Pass the injection
descriptor in the `deps` array when calling `bind().toSelf()` or `bind().toClass()`.

```ts
const di = new DiCaf()

di.bind(RequiredValidator).toSelf().extends(Validator)
di.bind(LengthValidator).toSelf().extends(Validator)
di.bind(ValidationPipeline).toSelf([allOf(Validator)])

await di.init()

const pipeline = di.get(ValidationPipeline)
```

---

## Summary

| Goal | Function |
| --- | --- |
| Inject all implementations as an ordered array | `allOf(key)` |
| Inject all implementations keyed by name | `mapped(key)` |
| Inject a single implementation | plain key or `optional(key)` |
| Inject across scope boundaries | `provide(key)` — see [Mixing Scopes](./mixing-scopes.md) |
