# Review of PR 51

[refactor(di)!: conditions as data, decided in dependency order](https://github.com/caffeinejs/caffeine/pull/51)
on `refactor/di-conditions` (`82b7151`, `f2ede7b`). Reviewed against `main` on 2026-09-26.

The change makes a condition data (`$cond` / `@Conditional` / `.conditional()`), holds every conditional binding until `compile()`, and decides the held set in `decisionOrder`. Profiles are one kind of condition. That model fixes the three bugs the PR closes, for the cases the new tests lock in:

- **#47.** A `@Provides` binding waits on its own `@Configuration` class (`PendingBinding.providedByConfig`), so one failing class does not drop another class's binding of the same key.
- **#48.** A decorated binding decided at `compile()` throws `ErrRepeatedInjectableConfiguration` when the key is already taken, whichever side is decided second.
- **#49.** `present` / `missing` / `config` wait for held bindings that answer to the checked key, so a default yields to a competitor declared later. Two defaults of one key stay consistent: the first declared registers, the second sees it and yields.

`@Profile` above `@Configuration()` gates the class's `@Provides` without copying profiles at decoration time. The `$i.value` → `$i.config` rename has no leftovers of `ConditionalOn`, `bindValuesProvider`, or `kValuesProvider`. `TestContainer` built from a source container sets `decorators: false`, and restoring an already compiled conditional into that container keeps the binding registered.

The holes are around that loop: bindings added while it runs, a compile that stops halfway, and a cycle the break does not leave consistent.

## 1. A conditional `bind()` during the decision loop is discarded

`compile()` runs modules, then `evaluatePendingConditionals()`. The loop iterates the array `decisionOrder` built once. Anything `bind()` holds after that — a `.conditional()` or `.profiles()` call from a `when` callback, or from the config provider factory `readConfigProvider` invokes — is appended to `_pendingConditionals` and then dropped:

```ts
this._pendingConditionals = []
this._pendingConfigClasses.clear()
```

There is no error. An unconditional `bind()` in the same callback does register, because `registerOrHold` calls `configureBinding` immediately.

Reproduced: a `when` callback bound `kLate` with `.conditional(c => c.when(() => true))`. After `init()`, `get(kLate)` threw `ErrNoResolutionForKey`.

`when` is documented as receiving nothing, so a closed-over container is outside the happy path. The failure mode is still silent, and the same clear drops any conditional binding made while a condition or the config factory runs.

## 2. `ConfigModule` replaces a held config provider

`std/config/integration/module.ts` decides it owns the provider by scanning `container.entries()`. `entries()` is the registry. A provider bound with `.conditional()` or `.profiles()` sits in `_pendingConditionals` until `compile()`, and modules run before that loop, so the scan misses it.

The module then `bindConfigProvider`s its own. `registerOrHold` treats that as a later hand binding of the same key and splices the held one out. The application's provider is gone, and the module's factory is what `config` conditions and `$i.config` read.

Reproduced with that same `entries()` check and a follow-up `bind(Keys.kConfigProvider, ...)`. The value after `init()` was the module's `{ from: 'module' }`, not the held `{ from: 'user' }`. An unconditional provider is visible in `entries()` and is left alone. `ConfigModule` itself was not booted; the sequence above is the one in `ConfigModule`.

## 3. A second pass treats an already registered decorated binding as a clash

The clash check in `evaluatePendingConditionals` is:

```ts
if (entry.byHand ? released.has(key) : this.registry.has(key)) {
  throw new ErrRepeatedInjectableConfiguration(...)
}
```

`released` records decorated bindings registered during this pass only. A decorated binding already in the registry always clashes, including one this container just restored and one an earlier, failed `compile()` already registered. A hand binding does not: it falls through to `configureBinding`, which replaces.

`compile()` sets `_compiled` only after the loop finishes, and the loop clears `_pendingConditionals` only then. A throw leaves the container half-decided and willing to compile again.

**Restore into a container that auto-wires.** `snapshot()` of a compiled container stores a passed conditional as a normal registry entry (no `kHeld`). `restore()` into `new CaffeineIoC()` — decorators on, so `autoWire` already holds that class — calls `configureBinding` for the snapshot entry and does not remove the pending decorated copy. `init()` then throws `ErrRepeatedInjectableConfiguration` (`Cannot register "ProbeRestored": another binding is registered under the key...`).

Restoring that same snapshot into `new CaffeineIoC({ decorators: false })` succeeds. That is what `TestContainer.build()` does when it was given a source. The empty `TestContainer` constructor snapshots an uninitialized container, and the "held twice" test covers that path. The broken path is a post-`compile()` snapshot restored into a default container.

**Retry after a throw.** A `when` that throws aborts the loop after every earlier binding has been registered and has emitted `onBindingRegistered`. A second `init()` walks the same pending list. The first decorated binding is already in the registry, so the second `init()` throws `ErrRepeatedInjectableConfiguration` and the original error is gone.

Reproduced with two decorated classes in one container: the earlier one passes `when(() => true)`, the later one throws. The first `init()` threw the original error. The second threw the clash on the earlier class. A lone hand binding whose `when` throws does retry: nothing was registered yet, and the second `init()` ran the callback again and completed.

## 4. A cycle across keys leaves a binding whose condition is false

`decisionOrder` breaks a cycle by deciding the earliest undecided binding while the bindings it waits for are still absent. For two `missing` defaults of one key that is consistent, and the guide describes that case: the first registers, the second sees it and yields, and the first's `missing` stays true because the second never registers.

Across keys it is not. A waits on `missing(B)`, B on `missing(C)`, C on `missing(A)`, each bound with `.extends(...)`. After `init()`:

| Key | Registered |
| --- | ---------- |
| A   | yes        |
| B   | yes        |
| C   | no         |

A was forced first, while B was still absent, so `missing(B)` passed. B was then free and `missing(C)` passed. C saw A and yielded. In the registry A is present and B is present, so A's condition is false and A is still registered. Nothing revisits a decision.

## 5. Dropping a `@Configuration` class from a snapshot still restores its `@Provides`

Class-level `@Conditional` / `@Profile` are not copied onto `@Provides` bindings. The provide registers only when `providedByConfig` is in the registry, and `restore()` sets `providedByConfig` only when that class is still in `_pendingConfigClasses`.

`Snapshot.exclude(ConfigClass)` (and `TestContainer.skip` of that class) removes the class entry and keeps the provide. On a `decorators: false` container the class is never added to `_pendingConfigClasses`, so the provide is held for its own conditions only. Those do not include the class profile. It passes, `configureBinding` registers it, and `compileFactory` then throws `ErrConfigurationBindingNotFound` (`Configuration binding not found for "ProbeConf"`) because `binding.source.ctor` is missing.

Reproduced with `@Profile('probe-profile')` on the class and no active profiles. With the class still in the snapshot, the profile would have skipped the class and the provide would have been left undecided. `focus()` is unaffected: `testing/_graph.ts` already treats `source.ctor` as a dependency, so the class stays in the snapshot.

## Smaller notes

`holdsBack` and `configureBinding` both call `metadataReader`. A registered binding is read twice (the built-in refresher and a single `bind()` were each read twice). A held binding that fails its condition is read once, from `holdsBack` only. `di/docs/reference/metadata-reader.md` still says the reader is called once per registration. A pure reader returns the same partial both times, so the hold decision and the spread in `configureBinding` agree. A reader that counts, logs, or returns a different partial the second time does not.

The same page's field table lists `scopeId`. The binding field is `scopeID`. The table was rewritten in this PR and the name was left as it was, so a reader written from the table sets a field `newBinding` ignores. That mismatch predates the PR.

## Checked

Behaviors above were run on this branch through a temporary `di/_tests` vitest file, since deleted. The suite claimed in the PR body (5582 passed) was not re-run.
