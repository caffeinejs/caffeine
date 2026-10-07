# `@caffeinejs/di`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

## Bindings and keys

- Every binding registers through one path in `compile()`, however it was made: decorated (`autoWire()`, private),
  bound by hand, bound by a module, or added by an override. Nothing is registered before `compile()`. Do not add a
  branch on where a binding came from.
- A key takes one binding once profiles and conditions are decided: a second one is `ErrDuplicateBinding`.
  `rebind(key)` and `overrides()` are the only replacements. `bind()` does not read decorators.
- A binding carrying conditions registers only once they pass at `compile()`, however it was made. A condition
  must never see its own binding, or a default written as `.conditional(c => c.missing(key))` removes itself, and a
  `@Configuration` class's conditions never see the `@Provides` it declares.
- Conditions are data from `$cond`, and their kinds are fixed: `present`, `missing`, `config`, `env`. A new kind is a
  design change, not a helper. A `present(key)` or `missing(key)` on a key a registered binding answers to is decided
  first, then `env` and `config`; any other `present(key)` or `missing(key)` is decided after every held binding that
  answers to `key`, and bindings that wait for each other are `ErrCircularCondition`.
- Condition logic lives in `conditional.ts`; `container.ts` only holds bindings and hands each round to
  `decideConditions`.
- `internal()` is a mark for tools, never a filter. The container, `snapshot()`, `overrides()` and `TestContainer`
  treat an internal binding like any other: never exempt, skip or drop a binding because it is internal.
- `token<T>(...)` brands an injection key only. Never use it for a label, tag, metadata key, resolver name or plain
  `Map` lookup.
- `T` must name what the key resolves to: `token()`, `token<any>`, `token<unknown>`, `token<object>` and a class
  with no members are type errors. Give the class a member.
- There is no escape hatch: a key whose value type a package cannot name is declared by whoever knows the type
  and passed in.
- `has(key)` is true exactly when `get(key)` would resolve, including through `.names(...)` or `.extends(Base)`.
  Read `registry` for "directly bound".
- A key's candidate list in `bindings` must not depend on registration order: registering joins the list
  (`mapUnder`), removing takes out one binding, and `rebind(key)` is the one deliberate replacement.
- Change `buildBindingGraph` (`graph/graph.ts`), `injectedBindings` (`binding.ts`) and `answersTo` (`conditional.ts`)
  together with `mapUnder`.

## Tests

- Do not mutate the module-level state in `decorators/registrar/registrar.ts` (`Bindings`, `ProvidedBindings`,
  `MetadataWeakMap`, `Injectables`) from tests. Use the public API and a fresh container for isolation.
- `await container.init()` before `container.get()` or `container.getMany()`: before it they throw
  `ErrInvalidContainerState`. `await container.compile()` before `has()`, `getBindings()` or `entries()`: before it
  nothing is registered, and a negative assertion passes vacuously.
- Every decorated class a test file declares registers into every container with decorators on. Give a fixture a
  `@Profile` and activate it where it is used, or a stray fixture breaks unrelated tests.

## Resolution stages

- An injection descriptor names stages, folded by `compileChain` into one `InjectionResolver` at compile time. A
  chain takes exactly one terminal (`ErrConflictingInjectionStages`). The walkthrough is in
  [`docs/reference/injection-resolvers.md`](docs/reference/injection-resolvers.md).
- The terminal always runs last; other stages keep declaration order. That is what makes `ordered(provide(key))`
  and `provide(ordered(key))` the same chain.
- `optional` is a flag, not a stage: only the terminal knows what an empty selection means. `defer` is only a
  `DeferredCtor` key, not a stage.
- A stage that only transforms `ctx.bindings` returns `next(...)` unchanged; wrapping it adds a call frame to every
  resolution.
- Hoist whatever a stage allocates out of the thunk it returns; `_tests/provider_injection.test.ts` asserts the
  identity of the `Provider` that `provide` builds once.
- Keep loops indexed over bindings captured at compile time, with no `map`, spread or closure inside the thunk.
- Measure a suspected regression in a dedicated file against a hand-written control of the previous shape;
  `benchmarks/di/container.bench.ts` is a smoke test whose cases reorder between processes.
- Import the resolver types, `BuiltInStages`, both registries and their accessors (`registerStage`,
  `bindResolver`, …) from `injection_resolver.ts`.
- Nothing under `internal/core/resolver/` may import `injection_builtin_stages.ts`. `container.ts` alone wires
  that table through `registerStage`.
- Do not widen `InjectionContext` for one stage's internal need; a stage that has to compile something calls
  `compileChain`.

## Process-wide registration

- `package.json` `"sideEffects"` lists the files that register at load (`_polyfill.js`, `container.js`, `scope.js`,
  `index.nodejs.js`). New process-wide registration lives in one of those. Never add a bare `import './foo.js'` to
  `index.ts`: bundlers drop it.

## Descriptors, scopes and lifecycle

- Inside an object spec a descriptor must come from an `$i` helper; a hand-written `{ key: X }` literal is a
  nested bag.
- A helper that builds on another ends by calling `encode`, never by spreading: the `kInjectionDescriptor` mark is
  non-enumerable and a spread drops it. `encode` stays private; `defineInjection<T>(descriptor)` is its public door.
- Object fields are lazy getters that resolve through the binding on every read. Never make a field resolve
  eagerly.
- The cache-hit path in `SingletonScope.provide()` stays a single map lookup with no property load on the value.
- Lifecycle hooks are `Binding.bootstrap` / `Binding.preDestroy`. There are no `@PreDestroy` / `@OnBootstrap`
  decorators; do not add them.
