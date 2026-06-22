---
sidebar_label: Metadata Reader
---

# Metadata Reader

```ts
import type { MetadataReader } from '@caffeine-projects/dicaf'
```

---

## MetadataReader

```ts
type MetadataReader = (key: Key) => Partial<Binding>
```

A function called once per binding registration, after decorator metadata is
collected. Its return value is merged over the decorator-derived binding config —
fields returned by the reader take precedence over decorator values.

Passed as the `metadataReader` option in the `DiCaf` constructor:

```ts
const di = new DiCaf({ metadataReader: myReader })
```

See [container options](./container.md#options) for the full options table.

### When to use

`MetadataReader` is an integration point for bridging external metadata sources
into DiCaf. Common use cases:

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
    return { scopeId: scopeOverrides.get(key) }
  }
  return {}
}
```

### Example — scope overrides from config

```ts
import { Scopes, type MetadataReader } from '@caffeine-projects/dicaf'

const overrides = new Map<unknown, symbol>([
  [UserService, Scopes.TRANSIENT],
  [AuditLogger, Scopes.REQUEST],
])

const reader: MetadataReader = key => {
  const scopeId = overrides.get(key)
  return scopeId ? { scopeId } : {}
}

const di = new DiCaf({ metadataReader: reader })
```

### Useful Binding fields to override

| Field | Type | Set by decorator |
|---|---|---|
| `scopeId` | `Identifier` | `@Lifetime` |
| `profiles` | `Set<Identifier>` | `@Profile` |
| `names` | `Identifier[]` | `@Named` |
| `lazy` | `boolean` | `@Lazy` |
| `primary` | `boolean` | `@Primary` |
| `fallback` | `boolean` | `@Fallback` |
| `conditionals` | `Conditional[]` | `@ConditionalOn` |

Returning factory-level fields (`factory`, `injections`, `injectionResolvers`)
from a reader is possible but unusual — prefer the fluent binder API for those.
