---
sidebar_label: Conditionals
---

# Conditionals

- [Conditional](#conditional)
- [ConditionContext](#conditioncontext)

Both types are exported from the main package:

```ts
import type { Conditional, ConditionContext } from '@caffeinejs/di'
```

---

## Conditional

```ts
type Conditional = (ctx: ConditionContext) => boolean | Promise<boolean>
```

A predicate evaluated once during `init()`. When it returns `false`, the
binding is skipped — it is not registered in the container for that run.

Used by:

- [`BindingSpec.conditional()`](./binding-spec.md#conditional) — fluent API
- [`@ConditionalOn`](./decorators.md#conditionalon) — decorator API

```ts
// synchronous
const hasRedis: Conditional = ctx => ctx.container.has(RedisClient)

// async
const featureEnabled: Conditional = async ctx => {
  const flags = ctx.container.get(FeatureFlags)
  return flags.isEnabled('new-cache')
}
```

Multiple predicates passed to `.conditional()` are ANDed — all must return
`true` for the binding to be registered.

---

## ConditionContext

```ts
interface ConditionContext {
  readonly container: {
    has(key: InjectionToken): boolean
  }
  readonly key: InjectionToken
  readonly binding: BindingDecoratorConfig
}
```

Passed to every `Conditional` predicate at evaluation time.

| Property        | Description                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `container.has` | Checks whether a binding is registered for the given key.                                                   |
| `key`           | The key of the binding being tested.                                                                        |
| `binding`       | The full decorator config for the binding: scope, name, labels, tags, and other metadata set by decorators. |

```ts
// guard on another binding being present
di.bind(RedisCacheService, t => t.toSelf().conditional(ctx => ctx.container.has(RedisClient)))

// inspect the binding's own key
di.bind(MetricsReporter, t => t.toSelf().conditional(ctx => ctx.key !== Symbol.for('noop')))
```
