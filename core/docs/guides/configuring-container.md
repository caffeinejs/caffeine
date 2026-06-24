# Configuring the Container

`CaffeineIoC` accepts an optional options object as its first constructor argument.
All fields are optional — omitting them gives you the defaults shown below.

```ts
import { CaffeineIoC } from '@caffeine-projects/dicaf'

const di = new CaffeineIoC({
  // options described in this guide
})
```

---

## `defaultScopeId`

**Default:** `Scopes.SINGLETON`

The scope applied to any binding that does not declare one explicitly.

```ts
import { Scopes } from '@caffeine-projects/dicaf'

const di = new CaffeineIoC({ defaultScopeId: Scopes.TRANSIENT })
```

Every binding in this container is transient unless it explicitly sets
`@Lifetime(Scopes.SINGLETON)` or calls `.scope(Scopes.SINGLETON)` on the binder.

Built-in scopes: `Scopes.SINGLETON`, `Scopes.TRANSIENT`, `Scopes.REFRESH`, `Scopes.REQUEST`. See the [Scopes reference](../reference/scopes.md).

---

## `lazy`

**Default:** `false`

Makes all bindings lazy by default — construction is deferred to the first
`get()` call instead of happening during `init()`.

```ts
const di = new CaffeineIoC({ lazy: true })
await di.init()
// nothing constructed yet

di.get(HeavyService) // constructed here
```

Individual bindings can opt out with `@Lazy(false)` or `.lazy(false)` on the binder.

Priority chain (highest first):

1. Binding-level `@Lazy()` / `.lazy()`
2. Container `lazy` option
3. Scope default

See the [Lazy guide](./lazy-bindings.md) for the full breakdown.

---

## `profiles`

**Default:** `[]`

Activates the named profiles. Bindings annotated with `@Profile('name')` are
only registered when the matching profile is active.

```ts
const di = new CaffeineIoC({ profiles: ['production'] })
```

```ts
@Profile('production')
@Injectable()
class S3Storage implements Storage { ... }

@Profile('test')
@Injectable()
class InMemoryStorage implements Storage { ... }
```

See the [Profiles guide](./profiles.md).

---

## `checks`

**Default:** `{ scopes: 'compatible-scopes-only', circularReferences: true }`

### `checks.scopes`

Controls scope validation at init time. Three modes:

| Mode | Behaviour |
|---|---|
| `'compatible-scopes-only'` | Durable scopes (singleton, container) cannot depend on shorter-lived scopes (transient, request). Reverse is allowed. |
| `'no-mix'` | Every dependency must share the exact scope as its consumer. |
| `'off'` | Validation disabled. |

```ts
const di = new CaffeineIoC({
  checks: { scopes: 'off' },
})
```

`'compatible-scopes-only'` is the practical default — it catches the common
mistake of a singleton holding a transient reference while still allowing
singletons to depend on other singletons.

### `checks.circularReferences`

When `true`, the container detects circular dependencies at init time and throws
before any instance is created.

```ts
const di = new CaffeineIoC({
  checks: { circularReferences: false },
})
```

Disable only if you are intentionally breaking cycles with `@Lazy()`. Keeping
it enabled surfaces new cycles introduced by future edits.

---

## `parent`

**Default:** `undefined`

Attaches a parent container. When a key is not found in the child, resolution
falls through to the parent.

```ts
const root = new CaffeineIoC()
await root.init()

const child = root.newChild()
await child.init()

// child.get(SomeService) → looks in child first, then root
```

Prefer `newChild()` over passing `parent` directly — `newChild()` copies
container-scoped bindings and post-processors automatically.

See the [child container section](./modules.md#child-containers) in the Modules guide.

---

## `decorators`

**Default:** `true`

When `true`, the container calls `autoWire()` in its constructor, registering
all `@Injectable`-decorated classes it finds in the global decorator registry.

Set to `false` for fully manual containers where no decorators are used:

```ts
const di = new CaffeineIoC({ decorators: false })

di.bind(Logger).toSelf()
di.bind(UserService).toClass(UserService, [Logger])

await di.init()
```

---

## `metadataReader`

**Default:** `undefined`

A function `(key: Key) => Partial<Binding>` called for every binding at
registration time. Its return value is merged into the binding, letting you
inject metadata from an external source (config files, environment variables,
feature flags) without decorators.

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

This is an advanced escape hatch. For most cases, decorators and binder options
cover the same ground with less ceremony.

---

## All options at a glance

| Option | Type | Default |
|---|---|---|
| `defaultScopeId` | `Identifier` | `Scopes.SINGLETON` |
| `lazy` | `boolean` | `false` |
| `profiles` | `Identifier[]` | `[]` |
| `checks.scopes` | `'compatible-scopes-only' \| 'no-mix' \| 'off'` | `'compatible-scopes-only'` |
| `checks.circularReferences` | `boolean` | `true` |
| `parent` | `Container` | `undefined` |
| `decorators` | `boolean` | `true` |
| `metadataReader` | `MetadataReader` | `undefined` |
