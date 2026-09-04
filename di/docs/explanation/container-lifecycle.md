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

During construction:

- Modules in `options.modules` are queued. They are not executed yet.
- When `decorators: true` (the default), `autoWire()` is called automatically.
  This scans the global decorator registry and registers every `@Injectable` and
  `@Configuration` class that has been imported so far.
- No instances are created.
- The container is not usable for resolution yet.

If you import decorated classes **after** calling `new CaffeineIoC()`, call
`di.autoWire()` manually to pick them up.

---

## Phase 2 — Init

```ts
await di.init()
```

During init, the container does all its heavy lifting:

1. **Module graph** — collect reachable modules from `Options.modules` /
   `addModules()`, then run each module `fn` once.
2. **Profile filtering** — bindings whose `@Profile` is not in the active set
   are dropped.
3. **Conditional evaluation** — `@ConditionalOn` predicates are evaluated;
   bindings that return `false` are dropped.
4. **Scope validation** — the container checks that no binding violates the
   configured scope rules (e.g. singleton depending on transient).
5. **Circular dependency detection** — the graph is checked for cycles.
6. **Injection resolver compilation** — the container compiles the injection
   strategy for each binding so resolution is fast.
7. **Eager instantiation** — all non-lazy singleton bindings are created. Async
   factories are awaited in dependency order.
8. **PostConstruct hooks** — `@PostConstruct` (and `.postConstruct()`) callbacks
   run after each instance is created.

`init()` is async because it awaits async factories. Skipping `init()` and
calling `get()` immediately is not safe — bindings may not be compiled and
instances will not exist.

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
- **Container** — returns the instance for the current container level.

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

1. **PreDestroy hooks** — `@PreDestroy` (and `.preDestroy()`) callbacks are
   called on all singleton instances in **reverse initialization order** —
   the last thing created is the first to be destroyed.
2. **Async cleanup** — hooks returning `Promise` are awaited.
3. **State cleared** — instances are released.

Transient instances are not tracked by the container, so `dispose()` does not
call their `@PreDestroy` hooks.

---

## Child containers

Child containers share the parent's binding registry but maintain their own
instance cache. They follow the same four phases:

```ts
const parent = new CaffeineIoC({ modules: [sharedModule] })
await parent.init()

const child = parent.newChild()
child.bind(TenantConfig, t => t.toValue(tenantCfg))
await child.init()

// child.get(UserService) — resolved against parent bindings
// child.get(TenantConfig) — resolved from child's own binding
```

Disposing the parent does not automatically dispose children.

---

## Refresh scope reset

The REFRESH scope sits between init and disposal. You can reset all refresh-
scoped instances at any point after `init()`:

```ts
await di.refresher.refresh()
```

The next `get()` for a refresh-scoped binding creates a fresh instance.
Pre-destroy hooks are **not** called on the old instances during refresh.

---

## Summary

| Phase        | How to enter           | What happens                         |
| ------------ | ---------------------- | ------------------------------------ |
| Construction | `new CaffeineIoC(...)` | Bindings registered, no instances    |
| Init         | `await di.init()`      | Graph validated, singletons created  |
| Resolution   | `di.get(...)`          | Instances returned per scope rules   |
| Disposal     | `await di.dispose()`   | PreDestroy hooks, instances released |
