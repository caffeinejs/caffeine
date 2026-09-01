# `@caffeinejs/di`

## `.fallback()` is order-dependent (known defect)

`.fallback()` only defers to a binding registered for the same key **after** it. Registered second, it wins —
so it does not do what its name suggests:

```ts
// This does NOT keep the first binding. The fallback overwrites it.
container.bind(CacheStore).toValue(userStore)
container.bind(CacheStore).toClass(MemoryCacheStore).fallback()
```

`fallback()` lives on `BinderOptions`, so `.toClass()` / `.toValue()` has already called `configureBinding`
by the time the flag is set, and `registerBinding` merges the second chain into the first. Only the decorator
path defers fallbacks (`pendingFallbacks` in `container.ts`), which is why `_tests/fallback.test.ts` passes
while the imperative equivalent does not.

Do not reach for `.fallback()` to replace a `has()` probe — it makes the problem worse, silently. Fixing it
means the imperative path deferring registration the way the decorator path does, and `configureBinding`
currently throws eagerly with tests depending on that (`_tests/extending_classes.test.ts`,
`_tests/manual_bind.test.ts`).

## `has()` means resolvable, not directly bound

`has(key)` is true exactly when `get(key)` would resolve — including a key reachable only through
`.names(...)` or `.extends(Base)`. When you need "is a binding registered *directly* under this key", read
`registry` instead, as `rebind` and the fallback registration loops do.

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
