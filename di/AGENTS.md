# `@caffeinejs/di`

## `.fallback()` is held back until `compile()`

A `bind()` call registers as soon as its callback returns — except when the spec called `.fallback()`. Those
bindings are queued and registered by `evaluatePendingFallbacks()`, after modules, profiles and conditionals
have settled, and only if nothing else has claimed the key. The first fallback for a key wins.

Two consequences, both deliberate:

- `has()`, `entries()` and `size` do not see a fallback-only key until `compile()`. Every other binding is
  still visible the moment `bind()` returns.
- `bind()` does not inherit `@Fallback` from a decorated class. Binding a key by hand is an explicit
  registration, so an override would otherwise defer to the default it is replacing.

## `has()` means resolvable, not directly bound

`has(key)` is true exactly when `get(key)` would resolve — including a key reachable only through
`.names(...)` or `.extends(Base)`. When you need "is a binding registered _directly_ under this key", read
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

## Process-wide registration and `"sideEffects"`

`package.json` `"sideEffects"` lists the published files that register at load (`_polyfill.js`, `container.js`,
`scope.js`, `index.nodejs.js`). New process-wide registration must live in one of those files, or be a live use
of an exported binding. Do not add a stray `import './foo.js'` to `index.ts`: the barrel is not on the allowlist,
so bundlers treat it as side-effect-free and will drop unused re-exports (and a bare polyfill import there).
`CaffeineIoC` always loads `container.js`, which is why `_polyfill.js` is imported from there.

`InjectionResolverFactoryContext` carries no compilation hook — it is the same shape a custom resolver registered
with `bindResolver` has always seen. Do not widen it for one factory's internal need; route that factory to the
registry instead, the way `object.ts` does.

## A descriptor is what `encode()` marked

`encode()` stamps `kInjectionDescriptor`, and every `$i` helper returns through it. That one mark is what both sides read: `InjectedField` tests it at the type level, `isDescriptor` tests it at run time. There is no heuristic left to drift — which matters, because the type and the runtime each guessing separately is precisely how `$i.just` came to typecheck and then throw.

So inside an object spec a descriptor **must** come from a helper. A raw key still works in every form (`isValidKey` is tested first: a class, a `token(...)`, a bare string or symbol, a `DeferredCtor`), and every other object is a nested bag — including a hand-written `{ key: X }` literal, which is a bag and not an injection.

The mark is non-enumerable, so it stays out of deep-equality and any dump of a descriptor. A spread therefore drops it: a helper that builds on another must end by calling `encode` rather than by spreading, and `compose` does exactly that.

Fields are lazy getters that resolve through the binding on every read. That is what makes one cached bag correct for singleton, transient and request scope alike — never make a field resolve eagerly.
