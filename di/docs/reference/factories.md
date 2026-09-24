# Factories

- [Factory](#factory)
- [AsyncFactory](#asyncfactory)
- [ResolutionContext](#resolutioncontext)

---

## Factory

```ts
type Factory<T> = (ctx: ResolutionContext) => T
```

A synchronous factory function. Used with `toFactory()` and `@UseFactory`.

```ts
di.bind(Logger, t =>
  t.toFactory(ctx => {
    const config = ctx.container.get(AppConfig)
    return new ConsoleLogger(config.logLevel)
  }),
)
```

```ts
@Injectable()
@UseFactory(ctx => new ConsoleLogger(ctx.container.get(AppConfig)))
class Logger { ... }
```

---

## AsyncFactory

```ts
type AsyncFactory<T> = (ctx: ResolutionContext) => Promise<T>
```

An async factory function. Used with `toAsyncFactory()`, `@UseAsyncFactory`, and
`@ProvidesAsync` inside `@Configuration` classes.

CaffeineIoC awaits the promise during `init()` — by the time `container.get()` is
called, the instance is already resolved.

**Constraints:**

- Scope must be singleton or refresh. Transient and request scopes are not allowed.
- Always eager — instantiated during `init()` regardless of lazy configuration.
- Property injection (`@InjectMember`) and method injection (`@InjectMethod`) are not supported.

```ts
// Fluent API
di.bind(DatabasePool, t =>
  t.toAsyncFactory(async ctx => {
    const cfg = ctx.container.get(AppConfig)
    return createPool(cfg.databaseUrl)
  }),
)
```

```ts
// Class decorator
@UseAsyncFactory(async ctx => {
  const cfg = ctx.container.get(AppConfig)
  return fetchConfig(cfg.vaultUrl)
})
@Injectable()
class RemoteConfig {}
```

```ts
// @Configuration method
@Configuration([AppConfig])
class InfraConfig {
  constructor(private readonly config: AppConfig) {}

  @ProvidesAsync(DatabasePool)
  async databasePool(): Promise<DatabasePool> {
    return createPool(this.config.databaseUrl)
  }
}
```

For a task-oriented walkthrough, see the [Async Bindings guide](../guides/async-bindings.md).

---

## ResolutionContext

Passed to every factory and interceptor. Gives access to the container and the binding being resolved.

| Property    | Description                                                             |
| ----------- | ----------------------------------------------------------------------- |
| `container` | The container. Use it to resolve other dependencies inside the factory. |
| `key`       | The key being resolved.                                                 |
| `binding`   | The full `Binding` descriptor for the current resolution.               |

```ts
di.bind(Greeter, t =>
  t.toFactory(ctx => {
    const name = ctx.container.get<string>('app.name')
    const binding = ctx.binding
    return new Greeter(name)
  }),
)
```
