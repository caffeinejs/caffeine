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

## Three modules own resolution, and the split is load-bearing

`injection_resolver_registry.ts` is a leaf: the `InjectionResolver` / `InjectionResolverFactory` /
`InjectionResolverFactoryContext` types, `BuiltInResolvers`, the registry `Map`, `bindResolver`, `unbindResolver`,
`hasResolver`, `resolverFor`, and `defaultResolverFor` (the shared rule for a descriptor naming no resolver:
`DEFER` for a `DeferredCtor` key, `DEFAULT` otherwise). It imports no factory, so it can be imported from anywhere
— including `internal/core/resolver/*`, which is where its types are consumed. **This is the module to import
from.** There is no re-export barrel in front of it, and adding one would violate `CONVENTIONS.md`.

`BuiltInResolvers` lives in the registry, not beside the factories, because `defaultResolverFor` reads two of its
symbols. Moving them out would make the registry import `built_in_resolvers.ts`, which imports the factories, one
of which (`object.ts`) imports the registry.

`built_in_resolvers.ts` exports one table pairing each built-in name with its factory. It performs no registration
and has no side effect. **Nothing under `internal/core/resolver/` may import it** — that import is the cycle the
split exists to avoid.

`container.ts` is what wires them, looping the table through `bindResolver` at module scope. That is a real value
dependency, so the built-ins cannot be silently dropped by tidying an unused import, and module scope gives
run-once semantics that make `bindResolver`'s duplicate-name throw a non-issue. A resolution before that loop runs
fails loudly with `ErrUnknownResolver`, which every test in the suite would catch.

`InjectionResolverFactoryContext` carries no compilation hook — it is the same shape a custom resolver registered
with `bindResolver` has always seen. Do not widen it for one factory's internal need; route that factory to the
registry instead, the way `object.ts` does.

## A descriptor is what `encode()` marked

`encode()` stamps `kInjectionDescriptor`, and every `$i` helper returns through it. That one mark is what both sides read: `InjectedField` tests it at the type level, `isDescriptor` tests it at run time. There is no heuristic left to drift — which matters, because the type and the runtime each guessing separately is precisely how `$i.just` came to typecheck and then throw.

So inside an object spec a descriptor **must** come from a helper. A raw key still works in every form (`isValidKey` is tested first: a class, a `token(...)`, a bare string or symbol, a `DeferredCtor`), and every other object is a nested bag — including a hand-written `{ key: X }` literal, which is a bag and not an injection.

The mark is non-enumerable, so it stays out of deep-equality and any dump of a descriptor. A spread therefore drops it: a helper that builds on another must end by calling `encode` rather than by spreading, and `compose` does exactly that.

Fields are lazy getters that resolve through the binding on every read. That is what makes one cached bag correct for singleton, transient and request scope alike — never make a field resolve eagerly.
