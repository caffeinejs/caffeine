# Options

Constructor options for the `CaffeineIoC` container.

```ts
import { CaffeineIoC } from '@caffeinejs/di'
import type { Options } from '@caffeinejs/di'

const di = new CaffeineIoC(options: Partial<Options>)
```

All fields are optional. Omitting them produces the defaults shown below.

---

## Fields

### `profiles`

```ts
profiles?: string[]
```

**Default:** `[]`

The set of active profiles. A binding annotated with `@Profile('name')` or
configured with `.profiles('name')` is registered only when `'name'` appears
in this array. Further profiles can be appended with `addProfiles()` until
`compile()`. Bindings with no profile restriction are always registered.

```ts
const di = new CaffeineIoC({ profiles: ['production'] })
```

See the [Profiles guide](../guides/profiles.md).

---

### `defaultScopeId`

```ts
defaultScopeId?: Identifier
```

**Default:** `Scopes.SINGLETON`

Scope applied to bindings that do not explicitly declare one via `@Lifetime()` or `.scope()`.

```ts
import { Scopes } from '@caffeinejs/di'

const di = new CaffeineIoC({ defaultScopeId: Scopes.TRANSIENT })
```

Built-in identifiers: `Scopes.SINGLETON`, `Scopes.TRANSIENT`, `Scopes.REFRESH`, `Scopes.REQUEST`. See the [Scopes reference](./scopes.md).

---

### `lazy`

```ts
lazy?: boolean
```

**Default:** `false`

When `true`, construction of eager-by-default bindings (singleton, container,
refresh) is deferred to the first `get()` call instead of running during `init()`.

Individual bindings override this with `@Lazy()` / `@Lazy(false)` or `.lazy()` / `.lazy(false)`.

Priority (highest first):

1. Binding-level `@Lazy()` / `.lazy()`
2. This option
3. Scope default

```ts
const di = new CaffeineIoC({ lazy: true })
await di.init()
// nothing constructed yet

di.get(SomeService) // constructed here
```

See the [Lazy guide](../guides/lazy-bindings.md).

---

### `parent`

```ts
parent?: Container
```

**Default:** `undefined`

A parent container. When a key cannot be resolved in the current container,
resolution falls through to the parent automatically.

Prefer `container.newChild()` over passing `parent` directly — `newChild()`
copies container-scoped bindings and post-processors automatically.

```ts
const root = new CaffeineIoC()
await root.init()

const child = root.newChild()
// child falls back to root for unregistered keys
await child.init()
```

---

### `checks`

```ts
checks?: {
  scopes?: ScopeCheckMode
  circularReferences?: boolean
}
```

Validation checks applied during `init()`.

#### `checks.scopes`

```ts
type ScopeCheckMode = 'compatible-scopes-only' | 'no-mix' | 'off'
```

**Default:** `'compatible-scopes-only'`

Controls scope compatibility validation.

| Mode                       | Behaviour                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `'compatible-scopes-only'` | A durable scope cannot depend directly on a shorter-lived one (transient, request) nor on a refresh binding. Reverse is allowed. |
| `'no-mix'`                 | Every dependency in a chain must share the exact same scope as its consumer.                                                     |
| `'off'`                    | Scope validation disabled.                                                                                                       |

`'compatible-scopes-only'` catches the most common mistake — a singleton
holding a transient reference — without blocking valid mixed-scope designs that
use `provide()`. Refresh counts as shorter-lived even though it is durable:
`refresher.refresh()` replaces the instance and runs its pre-destroy hook, so
only another refresh binding may hold one directly.

```ts
const di = new CaffeineIoC({ checks: { scopes: 'no-mix' } })
```

#### `checks.circularReferences`

```ts
circularReferences?: boolean
```

**Default:** `true`

When `true`, the container performs a graph traversal during `init()` and throws
`ErrCircularDependency` if a cycle is detected. Constructor, property and method
injections all count as edges — a scope caches an instance only after the
property and method injectors have run, so none of the three breaks a cycle.
Only `$i.defer()`, `$i.provide()` and an optional key nothing is bound to do.

The whole `checks` object is merged field by field, so passing one of the two
fields keeps the default of the other.

```ts
const di = new CaffeineIoC({ checks: { circularReferences: false } })
```

---

### `decorators`

```ts
decorators?: boolean
```

**Default:** `true`

When `true`, the container calls `autoWire()` in its constructor, registering
all `@Injectable`-decorated classes found in the global decorator registry at
construction time.

Set to `false` for fully manual containers with no decorators:

```ts
const di = new CaffeineIoC({ decorators: false })

di.bind(Logger, t => t.toSelf())
di.bind(UserService, t => t.toClass(UserService, [Logger]))

await di.init()
```

---

### `modules`

```ts
modules?: Array<Module | ModuleFn>
```

**Default:** `[]`

Modules to load during `compile()` / `init()`. A `Module` is an object with
`name`, optional `needs` / `provides` thunks, and optional `fn`. A `ModuleFn`
is a bare registration function; the container wraps it.

Further modules can be appended with `addModules()` until `init()`.

```ts
const di = new CaffeineIoC({ modules: [orderModule, userModule] })
```

See the [Modules guide](../guides/modules.md).

---

### `metadataReader`

```ts
metadataReader?: MetadataReader
```

**Default:** `undefined`

```ts
type MetadataReader = (key: InjectionToken) => Partial<Binding>
```

A function called for every binding at registration time. Its return value is
merged into the binding, allowing external metadata sources (config files,
environment variables) to override defaults without decorators.

```ts
const di = new CaffeineIoC({
  metadataReader: key => {
    if (key === DbConnection) {
      return { lazy: true }
    }
    return {}
  },
})
```

---

## Summary

| Field                       | Type                        | Default                    |
| --------------------------- | --------------------------- | -------------------------- |
| `profiles`                  | `string[]`                  | `[]`                       |
| `defaultScopeId`            | `Identifier`                | `Scopes.SINGLETON`         |
| `lazy`                      | `boolean`                   | `false`                    |
| `parent`                    | `Container`                 | `undefined`                |
| `checks.scopes`             | `ScopeCheckMode`            | `'compatible-scopes-only'` |
| `checks.circularReferences` | `boolean`                   | `true`                     |
| `decorators`                | `boolean`                   | `true`                     |
| `modules`                   | `Array<Module \| ModuleFn>` | `[]`                       |
| `metadataReader`            | `MetadataReader`            | `undefined`                |
