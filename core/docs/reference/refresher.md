---
sidebar_label: Refresher
---

# Refresher

```ts
import type { Refresher } from '@caffeinejs/core'
```

---

## Refresher

```ts
interface Refresher {
  refresh(): Promise<void>
}
```

Accessed via `container.refresher`. Controls `REFRESH`-scoped bindings —
singletons that can be discarded and recreated on demand.

After `refresh()` resolves, the next `container.get()` call for any
`REFRESH`-scoped key constructs a fresh instance. This applies to all reset
paths — `refresher.refresh()`, `container.resetInstances()`, and
`container.resetInstance(key)` — async bindings are re-awaited automatically
in all cases.

```ts
await container.refresher.refresh()
```

### Use case

`REFRESH` scope is designed for configuration or feature-flag objects that need
to be reloaded without restarting the container. A typical pattern:

```ts
@Injectable()
@Lifetime(Scopes.REFRESH)
class RemoteConfig {
  readonly flags = loadFlagsFromRemote()
}

// on a config-change event:
await container.refresher.refresh()

// next get() creates a new RemoteConfig with freshly loaded flags
const config = container.get(RemoteConfig)
```

See [Refresh scope](./scopes.md#refresh-scope) for the full scope semantics and
[`@Lifetime`](./decorators.md#lifetime) to mark a binding as refresh-scoped.
