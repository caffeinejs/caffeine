---
sidebar_label: Metadata Reader
---

# Metadata Reader

```ts
import type { MetadataReader } from '@caffeinejs/di'
```

---

## MetadataReader

```ts
type MetadataReader = (key: InjectionToken) => Partial<Binding>
```

A function called once for every binding, after decorator metadata is collected —
whether the container registers the binding at once or holds it back for its
conditions. Its return value is merged over the decorator-derived binding config —
fields returned by the reader take precedence over decorator values.

Passed as the `metadataReader` option in the `CaffeineIoC` constructor:

```ts
const di = new CaffeineIoC({ metadataReader: myReader })
```

See [container options](./container.md#options) for the full options table.

### When to use

`MetadataReader` is an integration point for bridging external metadata sources
into CaffeineIoC. Common use cases:

- Reading scope or profile overrides from a configuration file or environment
- Importing binding metadata from another framework's annotation system
- Applying organisation-wide defaults based on naming conventions

### Merge semantics

The returned `Partial<Binding>` is spread over the binding built from decorators.
Any field you return overwrites the decorator value for that binding; omitted
fields are left unchanged.

```ts
// decorator says SINGLETON; reader says TRANSIENT — TRANSIENT wins
const reader: MetadataReader = key => {
  if (scopeOverrides.has(key)) {
    return { scopeID: scopeOverrides.get(key) }
  }
  return {}
}
```

### Example — scope overrides from config

```ts
import { Scopes, type MetadataReader, type NamedToken, type Scope } from '@caffeinejs/di'

const overrides = new Map<unknown, NamedToken<Scope>>([
  [UserService, Scopes.TRANSIENT],
  [AuditLogger, Scopes.REQUEST],
])

const reader: MetadataReader = key => {
  const scopeID = overrides.get(key)
  return scopeID ? { scopeID } : {}
}

const di = new CaffeineIoC({ metadataReader: reader })
```

### Useful Binding fields to override

| Field          | Type                | Set by decorator           |
| -------------- | ------------------- | -------------------------- |
| `scopeID`      | `NamedToken<Scope>` | `@Lifetime`                |
| `names`        | `Identifier[]`      | `@Named`                   |
| `lazy`         | `boolean`           | `@Lazy`                    |
| `primary`      | `boolean`           | `@Primary`                 |
| `conditionals` | `Condition[]`       | `@Conditional`, `@Profile` |

A reader's `conditionals` replace the binding's own, profiles included — a profile is a
`profile` condition, built with `$cond.profile(...)`. They are read when the container
decides whether to hold the binding back, so a binding the reader makes conditional
waits for `compile()` like any other, and its conditions never see the binding itself.

Returning factory-level fields (`factory`, `injections`, `injectionResolvers`)
from a reader is possible but unusual — prefer the fluent binder API for those.
