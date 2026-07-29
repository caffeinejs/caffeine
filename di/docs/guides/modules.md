# Modules

A **module** is a plain function that receives a container and registers
bindings into it. Modules are how you compose imperative configuration — split
bindings into cohesive groups, import them by feature, and pass them to the
container at construction time.

```ts
import { CaffeineIoC, mod, type ContainerBindingOps } from '@caffeinejs/di'

function databaseModule(di: ContainerBindingOps) {
  di.bind(Database).toClass(PostgresDatabase)
  di.bind(UserRepository).toClass(UserRepository, [Database])
}

function emailModule(di: ContainerBindingOps) {
  di.bind(Mailer).toClass(SmtpMailer)
}

const di = new CaffeineIoC(databaseModule, emailModule)
await di.init()
```

Modules passed to the `CaffeineIoC` constructor are applied immediately, before
`init()` is called.

## Naming a module

Use `mod()` to attach a debug name to any module. The name appears in error
messages and hook events, making it easier to trace which module registered a
failing binding.

```ts
import { mod } from '@caffeinejs/di'

const databaseModule = mod('database', (di) => {
  di.bind(Database).toClass(PostgresDatabase)
})
```

## Async modules

Modules can be async. The container awaits each async module during `init()`.

```ts
const configModule = mod('config', async (di) => {
  const config = await loadConfigFromRemote()
  di.bind(AppConfig).toValue(config)
})

const di = new CaffeineIoC(configModule)
await di.init()
```

## Conditional registration

The preferred way to conditionally register a binding is `.conditional()` on
the binder. The predicate receives a `ConditionContext` with access to the
container's `has()` method, the binding key, and the binding config. It is
evaluated once during `init()`, so the container is partially available:

```ts
import { type ContainerBindingOps } from '@caffeinejs/di'

function storageModule(di: ContainerBindingOps) {
  di.bind(BlobStorage)
    .toClass(S3BlobStorage)
    .conditional(ctx => ctx.container.has(AppConfig))
}
```

Conditionals can be async:

```ts
di.bind(FeatureFlags)
  .toClass(RemoteFeatureFlags)
  .conditional(async ctx => {
    const cfg = ctx.container.has(AppConfig)
    return cfg && process.env.NODE_ENV === 'production'
  })
```

Plain `if`/`else` also works when the condition is known at module-registration
time (before `init()`):

```ts
function storageModule(di: ContainerBindingOps) {
  if (process.env.NODE_ENV === 'test') {
    di.bind(BlobStorage).toClass(InMemoryBlobStorage)
  } else {
    di.bind(BlobStorage).toClass(S3BlobStorage)
  }
}
```

For profile-based or decorator-driven activation, see
[`@Profile`](../reference/decorators.md#profile) and
[`@ConditionalOn`](../reference/decorators.md#conditionalon).

## Child containers

A child container inherits all bindings from its parent and can override or
extend them without affecting the parent. This is useful for request-scoped
setups or multi-tenant isolation.

```ts
const parent = new CaffeineIoC(commonModule)
await parent.init()

const child = parent.newChild()
child.bind(TenantConfig).toValue(tenantConfig)
await child.init()

const svc = child.get(UserService) // resolved from parent
```

See the [Container reference](../reference/container.md) for full `newChild()`
semantics.
