# `@caffeinejs/di`

## Every fallback is held back until `compile()`

A `bind()` call registers as soon as its callback returns — except for a fallback. Every fallback, whether the spec
called `.fallback()` or a class or `@Provides` method carries `@Fallback`, is queued and decided once by
`evaluatePendingFallbacks()`, after modules, profiles and conditionals have settled. It registers only if nothing
answers yet to its key, to a name it carries, or to the base it extends. The first fallback in the queue wins.

Two consequences, both deliberate:

- `has()`, `entries()` and `size` do not see a fallback-only key until `compile()`. Every other binding is
  still visible the moment it is registered.
- `bind()` does not inherit `@Fallback` from a decorated class. Binding a key by hand is an explicit
  registration, so an override would otherwise defer to the default it is replacing.

## `token()` is for injection keys only

`token<T>(...)` brands a string or symbol as a key the container resolves. It is not a general-purpose "typed
key" helper, and it must not be used for a label, a tag key, a metadata key, a resolver name, or a plain `Map`
lookup. Those are arbitrary keys in a key/value store; they stay plain `string` / `symbol`.

Nothing in the type system stops the misuse — `token<T>()` returns `string & TokenBrand<T>`, which satisfies
every `string` / `symbol` / `PropertyKey` parameter in the repo. Only the receiving parameter could reject it,
and the label/tag/metadata APIs deliberately do not, so this is a convention the reviewer enforces.

`T` has to name what the key resolves to. `token()`, `token<any>`, `token<unknown>` and `token<object>` are all
type errors. A class with no members is structurally `object`, so it is rejected too — give it a member, which
is worth doing regardless, since every value satisfies a member-less type and assertions against one pass
vacuously.

A scope identifier is an ordinary token that resolves a `Scope`: `token<Scope>(...)`. There is no separate
scope-key type, and the invariant brand is what keeps a service key out of `.lifetime()` / `@Lifetime` /
`bindScope`.

There is no escape hatch. A key whose value type the declaring package cannot name is not declared by that
package — it is declared by whoever knows the type, and passed in. The application configuration key works
exactly this way: the application writes `token<AppConfig>(...)` next to its schema and hands it to
`newConfiguration(schema, key)`.

## `has()` means resolvable, not directly bound

`has(key)` is true exactly when `get(key)` would resolve — including a key reachable only through
`.names(...)` or `.extends(Base)`. When you need "is a binding registered _directly_ under this key", read
`registry` instead.

## A key's candidate list is shared

`bindings` holds, for each key, every binding that answers to it: the one registered under the key, the ones named
after it and the ones extending it. `get` picks the primary out of that list and `allOf` takes all of it, so the list
must not depend on the order the bindings were registered in.

- Registering under a key joins the list (`mapUnder`). It never replaces it.
- Removing a binding (`unref`, for a rejected profile or conditional) takes out that binding alone.
- `rebind(key)` is the one deliberate replacement. It empties the key's list before registering, so overriding an
  abstract key wins over the bindings extending it; those stay registered under their own keys.
- Registering a key again unmaps the names, labels and base of the configuration it replaces, so they stop
  resolving to it.

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

## Resolution is a middleware chain

An injection descriptor names **stages**, not a resolver. `compileChain` folds them into the single
`InjectionResolver` the resolution path calls, once, while the container compiles.

```ts
type InjectionMiddleware<T> = (
  ctx: InjectionContext<T>,
  next: (ctx: InjectionContext<T>) => InjectionResolver<T>,
  args?: unknown,
) => InjectionResolver<T>
```

`ctx.bindings` is what travels down the chain, which is what lets a stage sort or filter bindings before anything
is materialized — impossible once instances exist, since order and names live on the `Binding`. A stage acts in
one of three ways:

- **transform** — change `ctx.bindings`, then `return next(...)`
- **wrap** — take what `next` returns and wrap it (`provide`)
- **materialize** — ignore `next` and produce the resolver (`allOf`, `mapped`, `just`, `value`, `object`, and the
  default single-binding terminal)

The third kind is **terminal**, declared at registration. A chain accepts exactly one; a second throws
`ErrConflictingInjectionStages` naming both, which is what `allOf(mapped(key))` now does instead of silently
letting one win.

Stages keep declaration order, except that the terminal always runs last. That single rule is what makes
`ordered(provide(key))` and `provide(ordered(key))` the same chain: one transforms bindings on the way down, the
other wraps the resolver on the way back up, so they never contend for the same slot.

Two things are deliberately _not_ stages. `optional` is a flag, because only the terminal knows what an empty
selection means — `undefined` for `mapped`, `[]` for `allOf`. And `defer` is only a `DeferredCtor` key: seeding
unwraps it, so collecting stages see the bindings, and the default terminal returns the proxy when the key is
deferred and not optional. That proxy is what breaks a real constructor cycle.

### Performance rules for a stage

The resolution path is hot enough that `classFactory` hand-unrolls arity 0-4. Every stage must therefore:

- return `next(...)` **unchanged** when it only transforms bindings — wrapping it adds a call frame to every
  resolution
- hoist whatever it allocates out of the thunk it returns. `provide` builds its `Provider` once at compile time;
  building one per read would allocate on every resolution _and_ break the identity `provider_injection.test.ts`
  asserts
- keep loops indexed over bindings captured at compile time, with no `map`, spread or closure inside the thunk

Measure a suspected regression in a dedicated file against a hand-written control of the previous shape. The
24-case `benchmarks/di/container.bench.ts` is a smoke test only: at 3-60 ns its cases reorder between processes,
so a difference there is not evidence on its own.

### The module split is load-bearing

`injection_resolver.ts` is a leaf: the `InjectionResolver` / `InjectionResolverFactory` /
`InjectionResolverFactoryContext` / `InjectionContext` / `InjectionMiddleware` types, `BuiltInStages`, both
registries, and their accessors — `registerStage`, `unregisterStage`, `hasStage`, `stageFor`, `isTerminalStage`,
plus `bindResolver`, `unbindResolver`, `hasResolver`, `resolverFor`. It imports no middleware, so it can be
imported from anywhere, including `internal/core/resolver/*` where its types are consumed. **This is the module to
import from.** There is no re-export barrel in front of it, and adding one would violate `CONVENTIONS.md`.

`injection_builtin_stages.ts` exports one table pairing each built-in name with its middleware and whether it is
terminal. It performs no registration and has no side effect. **Nothing under `internal/core/resolver/` may import
it** — that import is the cycle the split exists to avoid.

`container.ts` wires them, looping the table through `registerStage` at module scope. That is a real value
dependency, so the built-ins cannot be dropped by tidying an unused import, and module scope gives run-once
semantics that make `registerStage`'s duplicate-name throw a non-issue. A resolution before that loop runs fails
loudly with `ErrUnknownInjectionStage`, which every test in the suite would catch.

`bindResolver` is the escape hatch and keeps its old signature: an `InjectionResolverFactory` is already
`(ctx) => InjectionResolver`, which is a terminal written the long way. A descriptor names it through `resolver`
rather than `stages`, and wrapping stages such as `provide` still compose over it.

## Process-wide registration and `"sideEffects"`

`package.json` `"sideEffects"` lists the published files that register at load (`_polyfill.js`, `container.js`,
`scope.js`, `index.nodejs.js`). New process-wide registration must live in one of those files, or be a live use
of an exported binding. Do not add a stray `import './foo.js'` to `index.ts`: the barrel is not on the allowlist,
so bundlers treat it as side-effect-free and will drop unused re-exports (and a bare polyfill import there).
`CaffeineIoC` always loads `container.js`, which is why `_polyfill.js` is imported from there.

`InjectionContext` adds only `bindings` to the shape a custom resolver registered with `bindResolver` has always
seen. Do not widen it for one stage's internal need: a stage that has to compile something reaches for
`compileChain`, the way the object terminal does for each of its fields.

## A descriptor is what `encode()` marked

`encode()` stamps `kInjectionDescriptor`, and every `$i` helper returns through it. That one mark is what both sides read: `InjectedField` tests it at the type level, `isDescriptor` tests it at run time. There is no heuristic left to drift — which matters, because the type and the runtime each guessing separately is precisely how `$i.just` came to typecheck and then throw.

So inside an object spec a descriptor **must** come from a helper. A raw key still works in every form (`isValidKey` is tested first: a class, a `token(...)`, a bare string or symbol, a `DeferredCtor`), and every other object is a nested bag — including a hand-written `{ key: X }` literal, which is a bag and not an injection.

The helpers that accept a descriptor — `allOf`, `ordered`, `optional`, `provide` — and `ObjectInjectionSpec` all constrain it to the branded result, so a hand-written literal is now a type error rather than a run-time `ErrMissingInjectionKey`. The run-time checks stay for callers without types.

The mark is non-enumerable, so it stays out of deep-equality and any dump of a descriptor. A spread therefore drops it: a helper that builds on another must end by calling `encode` rather than by spreading, and `compose` does exactly that.

`encode` itself stays private; `defineInjection<T>(descriptor)` is its public door, and the only way a package
outside this one can produce an `InjectionResult`. That is what makes `registerStage` usable end to end: a
package registers its own terminal and returns `defineInjection` from its helper, and the result is accepted
everywhere an `$i` helper is. `kInjectionResult` is not exported, so the brand cannot be forged — a caller that
hand-writes the object still gets a bag.

Fields are lazy getters that resolve through the binding on every read. That is what makes one cached bag correct for singleton, transient and request scope alike — never make a field resolve eagerly.

## Disposal is reverse creation order, one hook at a time

`dispose()` does not walk `registry`. It collects `Scope.instances()` from every scope, sorts the entries by
the sequence they were created in, and runs `preDestroy` from the newest backwards, awaiting each hook before
the next starts. A dependency is cached only after its dependent's factory returns, so reverse creation order
is a topological teardown order — including for instances a factory pulled through `ctx.container.get()`,
which no declared-injection graph would see. `RequestScopeContext.destroy()` follows the same rule for a
request.

An instance reached through more than one binding runs one hook, the first the order reaches, so an aliased or
doubly-bound resource is closed once. Only reference types are deduplicated: two bindings holding `8080` are
two settings, not one socket.

The sequence counter is shared by every durable scope (`internal/core/scope/_sequence.ts`), because singleton
and refresh keep separate caches and a per-scope counter would lose their relative order.

`SingletonScope` records creation in `_created`, deliberately kept apart from `_cachedInstances`: the cache-hit
path in `provide()` must stay a single map lookup with no property load on the value. Only creation writes to
`_created`, and only disposal reads it.

## Lifecycle hooks are `Binding.bootstrap` / `Binding.preDestroy`

Three things feed those two fields, and `configureBinding` is the one place they converge. A class binding
opts in by **implementing** `OnBootstrap` / `OnDestroy` (`lifecycle.ts`): after the ctor is known,
`configureBinding` checks `ctor.prototype.onBootstrap` / `onDestroy` and fills the field if nothing else has.
`@OnLifecycle({ bootstrap, destroy })` on a `@Provides` method stores functions the same way the old
`@OnDestroy(fn)` did — through `extendMemberInjectableAttributes` and copied onto the factory config by
`configuration.ts`. `.bootstrap(fn)` / `.preDestroy(fn)` on `BindingSpec` are the programmatic form. An
explicit spec value or an `@OnLifecycle` callback wins over the interface method. `bootstrap` still requires
`Scopes.SINGLETON` — the check in `configureBinding` throws `ErrInvalidBinding` regardless of which form set
it. There are no `@PreDestroy` / `@OnBootstrap` decorators.
