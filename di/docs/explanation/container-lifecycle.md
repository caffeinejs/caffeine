# Container lifecycle

A CaffeineIoC container moves through four phases: **construction**, **init**,
**resolution**, and **disposal**. Understanding this sequence helps you know
where to register things, why `init()` must be called before `get()`, and what
`dispose()` guarantees.

---

## Phase 1 — Construction

```ts
const di = new CaffeineIoC({ modules: [moduleA, moduleB] })
```

During construction, and until `init()` starts:

- Modules in `options.modules` and `addModules()` are queued. They are not
  executed yet.
- `bind()`, `rebind()` and `aspect()` record what they declare. Nothing is
  registered yet, so `has()`, `getBindings()` and `entries()` see nothing.
- Profiles can still be added with `addProfiles()`, and overrides with
  `overrides()`.
- No instances are created.
- The container is not usable for resolution yet.

Decorated classes are not read here. A class decorated with `@Injectable` or
`@Configuration` is registered when the container compiles, so it only has to
be imported before `init()`, not before `new CaffeineIoC()`.

---

## Phase 2 — Init

```ts
await di.init()
```

During init, the container does all its heavy lifting. The first steps are
`compile()`, which `init()` runs when it has not run yet:

1. **Decorated bindings** — with `decorators: true` (the default), every
   `@Injectable` and `@Configuration` class imported so far is registered.
2. **Bindings made by hand** — what `bind()` and `aspect()` recorded is
   registered, in call order.
3. **Module graph** — collect reachable modules from `Options.modules` /
   `addModules()`, then run each module `fn` once. A module's `bind()`
   registers right away.
4. **Rebinds** — what `rebind()` recorded replaces whatever is registered under
   its key, a module's binding included.
5. **Profiles and conditions** — every binding goes through the same
   registration, however it was made: one whose profiles are not active is
   dropped, and one carrying conditions waits until everything else is
   registered and is then kept only if they pass. A `present()` or `missing()`
   condition on a key a binding without conditions answers to is checked
   first, then its `env` and `config` conditions; any other `present()` or
   `missing()` condition is decided after every binding that could answer to
   its key. A key takes one binding: a second one fails with
   `ErrDuplicateBinding`.
6. **Overrides** — the steps added with `overrides()` run, in order, over the
   bindings that are left.
7. **Circular dependency detection** — the graph is checked for cycles.
8. **Scope validation** — the container checks that no binding violates the
   configured scope rules (e.g. singleton depending on transient).
9. **Injection resolver compilation** — the container compiles the injection
   strategy for each binding so resolution is fast.
10. **Eager instantiation** — all non-lazy singleton bindings are created. Async
    factories are awaited in dependency order.
11. **PostConstruct hooks** — `@PostConstruct` (and `.postConstruct()`) callbacks
    run after each instance is created.
12. **Bootstrap hooks** — once every binding is resolved, `OnBootstrap` classes
    (and `@OnLifecycle` `bootstrap` / `.bootstrap()` callbacks) run in dependency
    order, each awaited before the next. Singleton bindings only.

`init()` is async because it awaits async factories. Calling `get()` before
`init()` throws `ErrInvalidContainerState`.

---

## Phase 3 — Resolution

```ts
const svc = di.get(UserService)
```

After `init()`, the container is ready. `get()`, `getOptional()`, `getMany()`,
`wrap()`, and `wrapMany()` all resolve instances according to their binding's scope:

- **Singleton** — returns the cached instance created during init.
- **Transient** — constructs and returns a fresh instance on every call.
- **Request** — returns the instance for the current `AsyncLocalStorage` context.
- **Refresh** — returns the cached instance; a new one is created after `refresher.refresh()`.

Resolution is synchronous for most scopes. Async factories are only awaited
during `init()`, not during resolution.

---

## Phase 4 — Disposal

```ts
await di.dispose()
```

`await using di = new CaffeineIoC(...)` is equivalent — the container implements
`Symbol.asyncDispose` as an alias of `dispose()`.

Disposal tears down the container:

1. **Destroy hooks** — an `OnDestroy` class's `onDestroy()`, an `@OnLifecycle`
   `destroy` callback, and `.preDestroy()` callbacks are
   called on every cached instance in **reverse creation order** — the last
   thing created is the first to be destroyed, so a dependency is still usable
   while the hook of whatever depends on it runs.
2. **One hook at a time** — hooks returning `Promise` are awaited before the
   next one starts. A hook that throws does not stop the rest; the failures
   surface together as an `AggregateError` once disposal has finished.
3. **One hook per instance** — when two bindings hand back the same object it
   is destroyed once, by the first hook the order reaches. Bindings holding
   equal primitives are unrelated and each keeps its hook.
4. **State cleared** — instances are released.

Transient instances are not tracked by the container, so `dispose()` does not
call their destroy hooks. Request-scoped instances are destroyed by their
own scope block, on the same reverse-creation-order rule, not by `dispose()`.

---

## Refresh scope reset

The REFRESH scope sits between init and disposal. You can reset all refresh-
scoped instances at any point after `init()`:

```ts
await di.refresher.refresh()
```

The next `get()` for a refresh-scoped binding creates a fresh instance. The old
instance's pre-destroy hook runs first, so no longer-lived component may hold
one directly — inject `$i.provide()` and read it per use.

---

## Summary

| Phase        | How to enter           | What happens                        |
| ------------ | ---------------------- | ----------------------------------- |
| Construction | `new CaffeineIoC(...)` | Bindings declared, none registered  |
| Init         | `await di.init()`      | Bindings registered, graph checked, |
|              |                        | singletons created                  |
| Resolution   | `di.get(...)`          | Instances returned per scope rules  |
| Disposal     | `await di.dispose()`   | Destroy hooks, instances released   |
