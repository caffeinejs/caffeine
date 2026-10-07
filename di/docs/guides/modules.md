# Modules

A **module** is a named registration graph: classes to import (so their
decorators evaluate), nested modules to load, and an optional function that
registers extra bindings. Pass modules through `Options.modules` or
`addModules()`. They run during `compile()` / `init()`, not in the constructor.

```ts
import { CaffeineIoC, mod, type ContainerBindingOps } from '@caffeinejs/di'

const databaseModule = mod('database', (di: ContainerBindingOps) => {
  di.bind(Database, t => t.toClass(PostgresDatabase))
  di.bind(UserRepository, t => t.toClass(UserRepository, [Database]))
})

const emailModule = mod('email', (di: ContainerBindingOps) => {
  di.bind(Mailer, t => t.toClass(SmtpMailer))
})

const di = new CaffeineIoC({ modules: [databaseModule, emailModule] })
await di.init()
```

`needs` and `provides` are optional thunks. They are called when the container
collects the graph, so circular file imports do not read a sibling module while
it is still evaluating. Omit either field when the list would be empty.

```ts
export const orderModule = mod({
  name: 'order',
  needs: () => [userModule],
  provides: () => [OrderController],
  fn: di => {
    di.bind(OrderProcessor, t => t.toSelf())
  },
})
```

A bare function is still accepted as a module. The container wraps it as
`{ name, fn }`.

## Naming a module

Use `mod(name, fn)` to attach a debug name. The name appears in hook events.

```ts
import { mod } from '@caffeinejs/di'

const databaseModule = mod('database', di => {
  di.bind(Database, t => t.toClass(PostgresDatabase))
})
```

`mod(module)` stamps an existing object. It does not call `needs` or `provides`.

## Async modules

Modules can be async. The container awaits each async `fn` during `init()`.

```ts
const configModule = mod('config', async di => {
  const config = await loadConfigFromRemote()
  di.bind(AppConfig, t => t.toValue(config))
})

const di = new CaffeineIoC({ modules: [configModule] })
await di.init()
```

## Conditional registration

The preferred way to conditionally register a binding is `.conditional()` on
the binder. It takes conditions built with `$cond`, or a callback handed `$cond`
that returns them. They are decided once, when the container compiles, so a
module's binding can check what another module binds:

```ts
import { type ContainerBindingOps } from '@caffeinejs/di'

function storageModule(di: ContainerBindingOps) {
  di.bind(BlobStorage, t => t.toClass(S3BlobStorage).conditional(c => c.present(AppConfig)))
}
```

Several conditions must all pass:

```ts
di.bind(FeatureFlags, t =>
  t.toClass(RemoteFeatureFlags).conditional(c => [c.present(AppConfig), c.env('NODE_ENV', 'production')]),
)
```

Plain `if`/`else` also works when the condition is known at module-registration
time (before `init()`):

```ts
function storageModule(di: ContainerBindingOps) {
  if (process.env.NODE_ENV === 'test') {
    di.bind(BlobStorage, t => t.toClass(InMemoryBlobStorage))
  } else {
    di.bind(BlobStorage, t => t.toClass(S3BlobStorage))
  }
}
```

For profile-based or decorator-driven activation, see
[`@Profile`](../reference/decorators.md#profile) and
[`@Conditional`](../reference/decorators.md#conditional).
