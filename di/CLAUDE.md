# Claude Code Guidelines — `@caffeinejs/di`

## Testing and registrar.ts

Do not mutate the module-level state in `decorators/registrar/registrar.ts` (`Bindings`, `ByNamespace`, `ProvidedBindings`, `MetadataWeakMap`, `Injectables`) from tests. These are global singletons shared across all tests in the same process; direct mutation causes test pollution and order-dependent failures.

Tests must interact with the CaffeineIoC container only through the public API (decorators, `CaffeineIoC`, `Scope`, etc.). If a test needs an isolated registry, use a child scope or a fresh container instance — never reach into the registrar's internal maps.

## Testing: always call init() before resolving

Any test that calls `container.get()`, `container.getRequired()`, or `container.getMany()` must first `await container.init()`. Skipping `init()` bypasses eager instantiation and injection-resolver setup, so beans may resolve as `undefined` or with missing dependencies.

```ts
// correct
const di = new CaffeineIoC({ modules: [mod] })
await di.init()
expect(di.get(Svc)).toBeInstanceOf(Svc)

// wrong — init() not called
const di = new CaffeineIoC({ modules: [mod] })
expect(di.get(Svc)).toBeInstanceOf(Svc)
```

The only tests that are safe to skip `init()` are those that inspect container metadata without resolving instances (e.g. `di.has()`, `di.size`, `di.getBinding()`).
