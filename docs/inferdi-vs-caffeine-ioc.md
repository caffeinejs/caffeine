# InferDI vs CaffeineIoC

Internal analysis of [InferDI](https://github.com/inferdi/inferdi) (`@inferdi/inferdi` v6.0.2) against CaffeineIoC (`@caffeinejs/di` in this workspace). Written 2026-09-03 from InferDI `main` (commit at clone time) and the current Caffeine sources.

This is not a proposal to replace CaffeineIoC. The two libraries solve overlapping problems with incompatible product shapes. The useful question is which InferDI ideas are worth stealing, and which would fight Caffeine’s existing architecture.

---

## 1. Verdict

InferDI is a **typed registration DSL**. The dependency graph is a TypeScript type that grows as you call `register*`. Invalid wiring is supposed to be unrepresentable. The runtime is a ~3 KiB gzip `Map` plus arity-unrolled `new Ctor(...)`.

CaffeineIoC is a **full IoC container for a framework**. Registration can come from decorators, modules, scanning, profiles, and conditionals. The container compiles, validates, and eagerly instantiates, then exposes a large resolution surface (`get` / `getMany` / `$i.*` / request scope / AOP). Types live on tokens and injection descriptors, not on the container instance.

They share: zero runtime dependencies, no `reflect-metadata`, explicit constructor dependency lists, singleton / scoped-or-request / transient lifetimes, runtime scope-leak checks, lazy wrappers, child containers that do not cascade dispose, LIFO-ish teardown with `AggregateError`.

They diverge on the thing that matters: **who knows the graph**. InferDI’s compiler does. CaffeineIoC’s runtime does, after `init()`.

Do not adopt InferDI’s core as Caffeine’s container. Do adopt several of its type-level and request-scope ideas. The highest-value, lowest-conflict items are:

1. Positional type-checking of constructor dependency tuples (`DepsOf`).
2. Type-narrowed factory callbacks so a singleton factory cannot `.get()` a scoped key (`AllowedDeps`).
3. Request-scope disposal that outlives the handler (InferDI’s adapters already solved a bug `http/AGENTS.md` documents).
4. Native `Symbol.dispose` / `using` on the container.

The “graph is the type” widening of `Container<T>` is the most interesting InferDI idea and the worst fit for Caffeine as it exists. Section 8 explains why.

---

## 2. What InferDI is

**Package:** `@inferdi/inferdi` v6.0.2. MIT. Node `>=16`, TypeScript `>=5.2`. Dual ESM/CJS, also on JSR. Core is one file: `packages/inferdi/src/Container.ts` (~2.7k lines). Published gzip budget is strictly `< 3072` bytes, enforced in CI.

**Mission** (from `MANIFESTO.md`): *“The graph is the type.”* Missing keys, wrong constructor positions, duplicate registrations, and singleton→scoped leaks should fail in the type checker. Runtime checks exist for `as` casts, captured outer containers, and dynamic keys.

**Public surface** is small:

```ts
class Container<T extends DependenciesMap = Record<never, never>> {
  constructor(options?: { fast?: boolean })
  declareScopeInputs<Inputs>()
  registerClass(key, Ctor, deps, lifetime?, lazyKey?)
  registerFactory(key, factory, …)
  registerAsyncFactory(key, factory, deps, lifetime?, lazyKey?)
  registerValue(key, value)
  override(key, value)
  use(fn | Module)
  createScope(inputs?)
  get(syncReadyKey)
  getAsync(readyKey): Promise
  has(key): key is keyof T
  dispose(): Promise<void>
  [Symbol.dispose]()
  [Symbol.asyncDispose]()
}
```

Plus types: `Spec`, `AsyncSpec`, `Lazy` / `AsyncLazy`, `Module`, `Lifetime`, `ScopeInputMap`, `WithRequirements`, and `Container.Resolve` / `Providers` / `ReadyKeys` helpers.

**Adapters** (separate packages, same version): `@inferdi/fastify`, `@inferdi/hono`, `@inferdi/koa`, `@inferdi/express`, `@inferdi/elysia`. They open a child scope per request and dispose it. They do not inject handler parameters, scan files, or add decorators.

**Deliberate non-goals** (manifesto §5–6):

- Decorators, `reflect-metadata`, transformers, plugins
- Auto-wiring, filesystem scanning, module discovery
- Class-as-token keys
- Proxy / cradle resolve
- Resolve-time hooks, interceptors, AOP
- `AsyncLocalStorage` in core
- Cascading parent→child dispose
- Auto cycle-breaking proxies
- Production `.override()`
- Graph analysis in the production core
- Framework glue in core
- Multi-binding / collections

InferDI will not become a universal IoC framework. That is written down as policy, not a gap.

### 2.1 How registration types work

`Container<T>` starts as `Container<Record<never, never>>`. Each `register*` **mutates `this` and returns `this` widened**:

```ts
Container<T & Record<K, Spec<V, L>>>
```

Keys are `string | symbol` only. Classes are constructors, not tokens. Interfaces are bound with an explicit type argument:

```ts
.registerFactory<'mailer', Mailer>('mailer', () => new SendGridMailer())
```

`registerClass` takes a positional `deps` tuple. `DepsOf` checks it against constructor parameter types **by position**. Swapping `['dsn', 'logger']` when the ctor is `(logger: Logger, dsn: string)` is a type error.

Each entry is a `Spec<V, L>` carrying value type and lifetime (`'singleton' | 'scoped' | 'transient'`). `AllowedDeps<T, L>` filters which keys a given lifetime may inject. Inside a singleton factory, `c.get('scopedKey')` is a type error.

Declarative async uses `registerAsyncFactory` → `AsyncSpec<V, L>`. Dependent classes become async transitively. `get()` rejects those keys; `getAsync()` accepts them. A Promise-returning `registerFactory` stays a *synchronous* graph entry whose value is the Promise — a separate, older contract.

Scope inputs (`declareScopeInputs<{ request: RequestContext }>()`) are type-only. `createScope({ request })` snapshots values into the child cache. Keys that still need inputs are not in `get` / `getAsync` until those inputs are provided. Nested scopes inherit provided inputs and keep a separate scoped-instance cache.

### 2.2 Runtime contract

Default `{ fast: false }`: mutable graph, parent-chain walk, runtime cycle / lifetime / root-scoped guards.

`{ fast: true }`: fixed graph. Finish every `register*` / `.use()` / `.override()` before the first `get()` or `createScope()`. Drops cycle and lifetime bookkeeping. Children read the registry owner directly and mirror delegated singletons. Only the literal `true` enables it; unknown option values fail safe to checked mode.

`get()` hot path: local `cache.get(key)` first. Nothing else runs on a hit. Class construction is unrolled for 0–7 constructor args.

Owned instances dispose LIFO. Probe order: `Symbol.asyncDispose` → `Symbol.dispose` → `.dispose()`. Multiple failures become one `AggregateError`. Parent and child do not dispose each other. `registerValue`, overrides, scope inputs, lazy wrappers, and transients are not owned.

`.override(key, value)` is a test hatch: type-checked assignability, scope-local, rejected if the key is already in the local cache.

### 2.3 Performance (InferDI’s numbers, not re-run)

Published 2026-08-17 Latin-square suite vs Inversify, Awilix, TSyringe, TypeDI, Typed Inject. InferDI fast is the 1.00× baseline on most rows. Hot singleton ~6.2 ns. CaffeineIoC is **not** in that suite. Treat the table as “InferDI vs decorator/metadata containers,” not vs Caffeine.

---

## 3. What CaffeineIoC is

**Package:** `@caffeinejs/di`. Zero runtime dependencies. Dist is on the order of **2 MB** (compiled JS + `.d.ts` for the whole surface). ~12k LOC across ~235 source files.

**Mission:** an application container. Bindings come from Stage 3 decorators, `mod()` graphs, and the fluent `Binder`. After `await init()` the container is sealed. Resolution is a compiled factory call. The rest of Caffeine (HTTP, Kafka, scan, testing, std application builder) sits on this.

**Public surface** is large. Container: `get` / `getOptional` / `getMany` / `wrap` / `wrapMany` / `bind` / `rebind` / `autoWire` / `build` / `builder` / `resolver` / `newChild` / `snapshot` / `restore` / `dispose` / graph renderers. Binder: `toClass` / `toSelf` / `toValue` / `toFactory` / `toAsyncFactory` / `toFunction` / `aliasOf`, then options for scope, names, labels, lazy, primary, fallback, profiles, conditionals, interceptors. Injection: `$i.allOf` / `ordered` / `mapped` / `optional` / `defer` / `object` / `provide` / `just` / `value` / `compose`. Decorators: `@Injectable`, `@Configuration`, `@Provides`, `@Lifetime`, `@Named`, `@Inject`, `@Lazy`, `@Primary`, `@Fallback`, `@Profile`, `@ConditionalOn`, `@PostConstruct`, `@PreDestroy`, `@Aspect`, and more. Scopes: `SINGLETON`, `TRANSIENT`, `REQUEST` (Node, `AsyncLocalStorage`), `REFRESH`, plus `bindScope` for custom scopes.

**Keys:** class constructors, abstract classes, `token<T>(string | symbol)`, `DeferredCtor`. Class-as-token is the default.

**Lifecycle:** construct → `compile()` / `init()` (modules, profiles, conditionals, circular-ref check, scope check, AOP weave, compile factories, eager singletons, await async factories) → resolve → `dispose()`. Resolving before `init()` is unsafe.

**Request scope:** not a child container. `RequestScope` + `RequestScopeManager.run(fn)` on `AsyncLocalStorage`. `@caffeinejs/http` starts it in Fastify `onRequest`. Ambient: any `get()` on the same async context sees the same instances.

**Testing:** `@caffeinejs/testing` `TestContainer` (snapshot / override / skip / focus / isolate). The container itself also has `snapshot()` / `restore()`.

**Known defects** (from `di/AGENTS.md` and `http/AGENTS.md`):

- Imperative `.fallback()` is order-dependent and can overwrite the primary binding. Decorator fallbacks work.
- `has(key)` means *resolvable* (aliases / `.extends()`), not *directly registered*.
- Request scope is destroyed when the `run()` promise settles. Streams and piped bodies can outlive that.

---

## 4. Philosophy

| Axis | InferDI | CaffeineIoC |
|---|---|---|
| Product | Typed container library | Framework IoC |
| Source of truth | TypeScript graph `T` on `Container<T>` | Runtime registry after `init()` |
| Registration style | One fluent chain; keep the latest returned type | Decorators + modules + binder, many call sites |
| Keys | `string \| symbol` | Class + branded `token<T>()` |
| Decorators | Forbidden in core | Stage 3, first-class; HTTP/Kafka sit on them |
| When work happens | Cheap register, cheap cached `get` | Heavy `init()`, then cheap compiled `get` |
| Invalid graph | Unrepresentable where TS can see it | Thrown as `Err*` at compile/init/resolve |
| Size | `< 3 KiB` gzip is a pillar | Full container; size is not a design constraint |
| Multi-binding | Not a feature | `getMany`, `$i.allOf` / `ordered` / `mapped`, `@Primary`, labels |
| Request context | Explicit `createScope(inputs)` | Ambient ALS |
| Async | Typed `get` vs `getAsync`; async is graph state | Awaited only during `init()`; `get()` stays sync |
| Extensibility | Adapters outside core; no resolve hooks | Injection resolvers, interceptors, AOP, custom scopes, metadata reader |

InferDI optimizes for **a closed, authored graph** that a compiler can see. CaffeineIoC optimizes for **an open application** assembled from packages, scans, profiles, and plugins that the compiler cannot see as one chain.

That is the fork. Most feature differences follow from it.

---

## 5. Feature matrix

| Feature | InferDI | CaffeineIoC |
|---|---|---|
| Class binding | `registerClass(key, Ctor, deps)` | `bind(Ctor).toSelf(deps)` / `@Injectable(deps)` |
| Factory | `registerFactory` (container or deps-aware) | `toFactory` / `@UseFactory` / `@Configuration`+`@Provides` |
| Value | `registerValue` (always singleton, not owned) | `toValue` |
| Async factory | `registerAsyncFactory` → `AsyncSpec`; `getAsync` | `toAsyncFactory`; awaited in `init()` only |
| Interface binding | Explicit type arg on factory | Abstract class + `.extends()` / `@Extends`, or `token<I>()` |
| Duplicate key | Type error (`NoKeyOverlap`) | Runtime merge / `rebind` / `@Primary` |
| Ctor arg order | Type-checked by position | Runtime arity check (`ctor.length`); **types of args not checked** |
| Scope leak (singleton ← scoped) | Type error + runtime (checked mode) | Runtime at `init()` (`checks.scopes`) |
| Factory body lifetime filter | `c.get` narrowed by `AllowedDeps` | Factory receives `ResolutionContext`; not lifetime-narrowed |
| Scopes | `singleton`, `scoped`, `transient` | `SINGLETON`, `TRANSIENT`, `REQUEST`, `REFRESH`, custom |
| Request / child scope | `createScope()` child container | ALS `RequestScope`; also `newChild()` |
| Scope inputs | Typed `declareScopeInputs` + `createScope(inputs)` | Request-scoped bindings, or `ctx.state` outside DI |
| Lazy | Companion key `Lazy<T>` / `AsyncLazy<T>`; preserves target lifetime | `.lazy()` / `@Lazy` (defer eager init); `$i.provide` → `Provider<T>` (defer each read) |
| Circular deps | Fluent mutual keys rejected; runtime cycle detector; break with `Lazy<singleton>` | Compile-time DFS; skip optional/multi/`$i.defer` |
| Modules | `.use()` lambda or `Module<Req, Prov>` type contract | `mod({ needs, provides, fn })` runtime graph |
| Profiles / conditionals | Ordinary functions around `createScope` / `.use()` | `@Profile`, `@ConditionalOn`, `.profiles()`, `.conditional()` |
| Fallback bindings | No (use `.override` in tests) | `.fallback()` / `@Fallback` (imperative path is buggy) |
| Collections | No | `getMany`, `$i.allOf` / `ordered` / `mapped` |
| Optional inject | No first-class optional | `$i.optional` |
| Object / bag inject | No | `$i.object` with lazy getters |
| Config slices | Scope inputs or `registerValue` | `bindValuesProvider` + `$i.value` |
| AOP / interceptors | Explicitly rejected | `@Aspect`, `$aop`, `PostResolutionInterceptor`, `PostProcessor` |
| Custom injection resolvers | No | `bindResolver` |
| File scanning | No | `@caffeinejs/scan` |
| Graph viz | Proposal only (`@inferdi/graph`) | `graphToMermaid` / DOT / Markdown / JSON / text |
| Testing | `.override()`, `Container.Providers<C>` | `TestContainer`, `snapshot`/`restore` |
| `has()` | Registration probe; type guard to `keyof T`; not readiness | Resolvable, including aliases/extends |
| Sealed after boot | Only with `{ fast: true }` | Yes, after `init()` |
| `Symbol.dispose` / `using` | Yes, with Node `<20.4` polyfill | `dispose()` only |
| Dispose order | Sequential LIFO, then `AggregateError` | Reverse init order queued, `Promise.allSettled`, then `AggregateError` |
| Child dispose cascade | No | No |
| Transient PreDestroy | Not owned | Not tracked |
| Fastify request scope | `@inferdi/fastify`; `request.di`; waits response; `skipInferdiDispose` | ALS in `@caffeinejs/http`; dies with handler promise |
| Other HTTP adapters | Hono, Koa, Express, Elysia | Fastify only |
| Class as token | No | Yes (default) |
| Stage 3 decorators | No | Yes |

---

## 6. Differences that actually change how you write code

### 6.1 Type system

**InferDI.** After the fluent chain, `container.get('userRepo')` is typed as `UserRepo` because `'userRepo'` is in `T`. An unregistered key is a type error. A scoped key is not in root `get()`. An `AsyncSpec` key is not in `get()`. `Container.Resolve<typeof build>` extracts `{ key: Value }` for handlers and tests.

**CaffeineIoC.** `get<T>(key: InjectionToken<T>)` takes the type from the token. `di.get(UserService)` types as `UserService` whether or not anything was bound. `token<Logger>('logger')` brands the primitive; the container instance is not generic over registered keys. `$i` helpers *do* thread types (`ResolveInjection`, `InjectedOf`) into constructor bags, and HTTP’s programmatic `Router` already uses phantom accumulation (`RoutesOf<T>`). The **container itself** does not.

Caffeine’s `toClass(ctor, injections)` checks `injections.length === ctor.length` at **runtime**. It does not check that injection `i` is assignable to constructor parameter `i`. `@Injectable([deps])` is `Injection[]` — same gap.

InferDI’s `DepsOf` is the feature Caffeine is missing on the programmatic and decorator paths alike.

**Stale-alias footgun (InferDI).** Reusing an older builder variable keeps the old `T` while mutating the same runtime object. InferDI documents this; Caffeine would inherit it if it ever widened `CaffeineIoC<T>`.

**Structural sameness (InferDI).** Two deps of the same shape are interchangeable unless branded or keyed by `unique symbol`. Caffeine’s class tokens are already nominal at the key level (different constructors are different keys) even when the instance types match.

### 6.2 Keys

InferDI: strings and symbols. Collision-free private `Symbol()`, shared `Symbol.for()`, `unique symbol` for nominal typing. Classes cannot be keys. That forces an extra string at every registration and every `get`.

Caffeine: the class *is* the key. That matches `@Injectable` / `@Controller` and avoids a parallel string namespace. `token<T>()` exists for interfaces and non-class values. InferDI’s string-key model is a worse fit for Caffeine’s decorator-first packages.

### 6.3 Lifetimes and request context

InferDI has no `'request'` lifetime. Request scope **is** a child container. Request data enters as **scope inputs**, typed and explicit:

```ts
const root = new Container()
  .declareScopeInputs<{ request: RequestContext; auth: AuthContext }>()
  .registerClass('accountService', AccountService, ['request', 'auth'], 'scoped')

const publicScope = root.createScope({ request })
const authenticated = publicScope.createScope({ auth })
```

Caffeine’s `Scopes.REQUEST` is ambient ALS. A singleton that needs per-request data uses `$i.provide` / `Provider` (or `$i.object` lazy getters). HTTP also has `ctx.state` for non-DI request values (`http/AGENTS.md`).

InferDI’s captured `Lazy` binds the **container that resolved the wrapper**, not the current request. InferDI’s own docs say: use ALS if a singleton needs a dynamic per-request view. So InferDI did not “solve” ambient request access; it refused it in core and pushed it to the application.

Caffeine’s ALS is the right default for a framework where controllers and middleware call `container.get()` without passing a scope around. InferDI’s explicit scope is the right default for a library where every resolve goes through `request.di`.

The part Caffeine should steal is **not** “delete ALS.” It is **typed request values as DI inputs** and **disposal that matches the HTTP response**, not the handler promise.

### 6.4 Async

**InferDI.** Async is a type-state. `getAsync('repository')` returns `Promise<Repository>`. Concurrent singleton/scoped `getAsync` single-flights one cached Promise. You can resolve an async graph on first use, including per-request.

**CaffeineIoC.** Async is an init-time concern. Async factories are singleton/refresh only, always eager, no property/method injection. After `init()`, `get()` is synchronous. That is simpler for a boot-then-serve server. It cannot express “open a DB pool on first request” or “this scoped service is async” without doing the await yourself.

Caffeine’s constraint is a product choice, not an accident. Copying `getAsync` wholesale would split every resolution API and every HTTP handler. A narrower steal: allow async *scoped* factories whose Promise is single-flighted per request scope, if that becomes a real need.

### 6.5 Lazy vs Provider

InferDI `Lazy<T>`: companion key, `get(): T`, does not start the target until called, preserves target lifetime, illegal for singleton←scoped even when wrapped.

Caffeine has two different tools:

- `.lazy()` / `@Lazy` — skip eager `init()` construction. First `get()` still returns `T`, not a wrapper.
- `$i.provide(K)` — inject `Provider<T>`; each `.get()` re-resolves. This is how Caffeine *fixes* scope leaks, which InferDI forbids even through `Lazy`.

Caffeine’s `Provider` is more powerful for mixed scopes. InferDI’s `Lazy` is more precise about “do not construct yet” vs “construct every time.” Caffeine could add an InferDI-style `Lazy<T>` injection without removing `Provider`. They are not the same.

### 6.6 Modules

InferDI `Module<Req, Prov>` is a type-level function: the callback sees only declared requirements; outputs must not collide; extra graph entries are allowed.

Caffeine `mod({ name, needs, provides, fn })` is a **runtime** DAG. `needs` / `provides` are thunks so ESM cycles work. `fn` receives `ContainerBindingOps`. There is no type-level proof that `needs` exist or that `provides` were actually bound.

Caffeine modules are the right shape for a plugin system (`app.extend(...)`, scan, many packages). InferDI modules are the right shape for a single compiled graph. Type-checking `needs`/`provides` against `fn` is a leverage item; replacing `mod()` with InferDI’s `Module` is not.

### 6.7 Disposal

Both: reverse-creation intent, `AggregateError` on multiple failures, no parent→child cascade, transients not owned.

Differences:

- InferDI implements `Symbol.dispose` / `Symbol.asyncDispose` and `using` / `await using`. Caffeine has `dispose()` only.
- InferDI runs disposers **sequentially LIFO**. Caffeine queues them and `Promise.allSettled`s — reverse *registry* order, but **concurrent**.
- InferDI probes `asyncDispose` then `dispose` then `.dispose()`. Caffeine runs `@PreDestroy` / `.preDestroy()` then scope `reset`.
- InferDI sync `[Symbol.dispose]` refuses async resources loudly. Caffeine has no sync dispose path.

Caffeine already documents reverse initialization order. Parallel `allSettled` can close a dependency before a dependent’s `preDestroy` finishes. Sequential LIFO is the InferDI behavior worth copying if teardown races show up.

### 6.8 Fastify integration (this is a real Caffeine bug)

InferDI `@inferdi/fastify`:

- `app.di` = root, `request.di` = per-request scope
- Disposes after the response; stream adapters wait for Node `finish`/`close` (Koa/Express) or document `skipInferdiDispose` (Hono/Elysia/Fastify streaming)
- Failed requests still dispose; skip is for successful responses that outlive the handler
- `disposeRootOnClose` optional

Caffeine `@caffeinejs/http`:

- Same Fastify process, but scope is ALS started in `onRequest` with `requestScopeManager.run(() => done())`
- `RequestScope.run` destroys the scope when that callback’s promise settles
- `http/AGENTS.md`: *“Work that continues after the handler returns (streams, piped bodies) can outlive that. Do not invent a second stream scope; if lifetime is wrong, fix how the adapter awaits the request.”*

InferDI’s adapter already has the policy Caffeine’s HTTP package asked for: tie scope lifetime to the **response**, and offer an explicit skip when the application takes ownership.

### 6.9 What Caffeine has that InferDI will not add

These are not InferDI gaps to fill in Caffeine. They are Caffeine’s job:

- Decorator-driven HTTP/Kafka registration
- Multi-binding (plugins, validators, interceptors as collections)
- `$i.object` mixed-scope bags (HTTP programmatic routes depend on this)
- Profiles, conditionals, scanning
- Custom scopes and `REFRESH`
- AOP and post-processors
- Graph renderers / devtools
- `TestContainer` isolation (skip/focus/modules)
- Class-as-token + abstract `.extends()`
- Injection resolver plugins

InferDI’s manifesto says it will reject PRs that add most of that to core. Caffeine should not drop them to look like InferDI.

---

## 7. Features Caffeine could leverage

Ranked by **value to Caffeine** × **fit with existing architecture**. Effort is a judgment, not a schedule.

### P1 — High value, fits current design

#### 7.1 Positional type-check of constructor dependency lists

**What InferDI does.** `DepsOf<AllowedDeps<T, L>, A>` maps constructor parameters to legal keys by position and assignability.

**What Caffeine does.** Runtime `ctor.length` vs `injections.length`. Types of the list are `Injection[]`. `$i` descriptors carry output types (`ResolveInjection`) but are not checked against the constructor.

**Why it matters.** A swapped `Logger`/`Config` still typechecks today and blows up at `init()` or worse, constructs with the wrong object. InferDI’s “fearless refactoring” claim is this check.

**How to take it without becoming InferDI.** Genericize `Binder.toClass` / `toSelf` / `@Injectable(deps)` / `@Provides` so `injections` is a tuple assignable to the constructor parameter types (tokens and descriptors, not InferDI string keys). Keep class-as-token: the check is “does `InjectionToken<T>` / `InjectionDescriptor<T>` match parameter `T`,” not “does key `'logger'` yield `Logger`.”

**Risk.** Stage 3 decorator typing is awkward; overloads on `@Injectable` already exist. `Injection[]` vs tuple inference will fight optional/`allOf` wrappers. Worth a prototype on `toClass` first, then decorators.

**Do not** require string keys to make this work.

#### 7.2 Lifetime-narrowed factory callbacks

**What InferDI does.** Inside `registerFactory(..., 'singleton')`, `c` only exposes singleton-safe keys.

**What Caffeine does.** Runtime `checks.scopes` at `init()`. `Factory` is `(ctx: ResolutionContext) => T` with the full container. A factory can `ctx.get(RequestScoped)` and the leak is caught later, or missed if checks are `'off'`.

**How to take it.** Type `ResolutionContext` (or a factory `get`) with a lifetime parameter. Default bindings keep runtime checks. This is independent of widening `CaffeineIoC<T>`.

**Risk.** `ResolutionContext` is used widely. Narrowing `get` may break legitimate `Provider` / `$i.object` patterns unless those remain visible. InferDI forbids singleton←`Lazy<scoped>`; Caffeine *wants* singleton←`Provider<scoped>`. The filter must treat `Provider` / `$i.provide` as legal, unlike InferDI `Lazy`.

#### 7.3 Request-scope lifetime vs HTTP response

**What InferDI does.** Adapters dispose on response completion; `skipInferdiDispose` transfers ownership for streams.

**What Caffeine does.** ALS scope ends with the `onRequest` callback. Documented defect.

**How to take it.** In `@caffeinejs/http`, keep ALS (controllers still `container.get()`), but end `requestScopeManager.run` when the response finishes (or when the application calls an explicit skip). InferDI’s Fastify plugin is a concrete playbook: `onResponse` / `onError`, skip flag, failed requests still dispose.

This is the cheapest high-impact steal. It does not touch `di/` types. It fixes a known HTTP bug.

#### 7.4 `Symbol.dispose` / `Symbol.asyncDispose`

**What InferDI does.** Container is `using`-compatible; Node `<20.4` polyfill via `Symbol.for`.

**What Caffeine does.** `await di.dispose()` only.

**How to take it.** Implement the two well-known symbols as aliases of existing `dispose()`. Do not change hook semantics in the same change. Sequential LIFO can be a follow-up if parallel `allSettled` is shown to race `preDestroy`.

Low risk. Matches language direction. Tests should cover “sync dispose of async `preDestroy`” the way InferDI reports misuse rather than firing background cleanup.

### P2 — High value, real design tension

#### 7.5 Typed scope inputs for request data

**What InferDI does.** Request/auth/tenant values are declared on the graph. Readiness is type state. Nested `createScope` adds more inputs.

**What Caffeine does.** Request-scoped *classes*. Plain values go to `ctx.state` and are **not** in DI (`http/AGENTS.md`). Mixing them is a boundary the HTTP package is trying to keep clean.

**Why consider it.** Today a request-scoped service that needs `requestId` either reads ALS/`ctx` internally (hidden) or is constructed with a factory that pulls from ALS (untyped). InferDI makes `requestId` a keyed, typed dependency.

**Tension.** Caffeine’s “DI is for injectables with a lifecycle; `ctx.state` is for plain request values” is intentional. Scope inputs blur that. A Caffeine-shaped version might be: typed `RequestScopeManager.run(fn, inputs)` that binds input tokens for the duration of the ALS context, without a child container.

**Do not** replace `ctx.state` with DI keys for every middleware variable. That is the collision the HTTP package already forbids.

#### 7.6 Type-level module requirements

**What InferDI does.** `Module<Req, Prov>` fails to typecheck if the actual graph is missing a requirement or an output collides.

**What Caffeine does.** `needs` / `provides` are documentation-ish thunks used for topological order, not proof.

**How to take it.** Optional typed `mod` helper: `mod<Needs, Provides>(...)` that types `fn`’s `bind`/`get`. Keep untyped `mod('name', fn)` for plugins. Do not require the whole app to be one inferred chain.

**Risk.** Caffeine modules run inside `compile()`, not as a fluent return value. The container is not generic. Typed modules would be local contracts, InferDI-style, not a global `T`.

#### 7.7 Duplicate-key rejection at the type level on a single binder chain

InferDI’s `NoKeyOverlap` is excellent on a fluent builder. Caffeine *wants* multiple bindings per key (collections, `@Primary`, `.names()`, `.extends()`). A blanket InferDI uniqueness rule would break plugins.

A narrower version: type-error on a second `.bind(ExactKey).toSelf()` in the **same module function** unless `.rebind()` / `.names()` / multi-bind APIs are used. Hard to encode without a per-module phantom. Lower priority than 7.1.

#### 7.8 Declarative async as graph state (`get` vs `getAsync`)

Useful for “scoped async resource per request.” Conflicts with “all async happens in `init()`.” Only pursue if Caffeine needs lazy async scoped resources. Do not split `get()` for singletons that already initialize at boot.

### P3 — Worth copying as craft, not as features

#### 7.9 Checked vs fast as a documented contract

InferDI’s `{ fast: true }` is a **fixed-graph** promise: no mutation after first resolve, children before ancestors on dispose, no cycles.

Caffeine already seals after `init()` and compiles factories. That *is* a fast contract. What is worth copying is the **written checklist** (manifesto §4): what you may assume after `init()`, what `newChild()` invalidates, what `{fast: true}`-style flags (`checks.scopes: 'off'`, `checks.circularReferences: false`) actually disable.

Caffeine does not need a second resolve implementation.

#### 7.10 Test override typing

InferDI `.override('logger', mock)` checks assignability to the registered type and refuses unknown keys.

Caffeine `TestContainer` already overrides; verify mocks are checked against the binding’s instance type the same way. If they are only runtime, tighten the types. Small.

#### 7.11 `Container.Resolve` / `Providers` extraction

InferDI extracts a flat map from a builder’s return type. Caffeine apps typically pass `CaffeineIoC`, not a custom builder type. Still useful for `mod()`-style factory functions that return a typed handle. HTTP already does phantom accumulation on `Router`. Same technique, different type.

#### 7.12 Error message quality

InferDI’s diagnostics are sentences with a next action: *“Scoped X cannot be resolved from the root container. Use createScope().”* Caffeine’s `Err*` classes are structured and documented in `di/docs/reference/errors.md`. Audit whether scope-leak and cycle messages name both bindings and the fix (`Provider` / `$i.defer`) as clearly as InferDI names `Lazy<T>` / `createScope()`.

#### 7.13 Bundle-size discipline

Do not put a 3 KiB cap on `@caffeinejs/di`. Do copy the **habit**: hot path of `get()` should stay a compiled factory + scope cache lookup; do not add work before the cache hit; keep `Registration`-like objects monomorphic. InferDI’s manifesto §2.4 is a good review filter for `di/` PRs that touch resolve.

#### 7.14 Sequential LIFO dispose

See 6.7. Switch from `allSettled` parallel to sequential reverse-init if `preDestroy` ordering bugs appear. InferDI also de-dups by identity so two factories that returned the same resource close it once.

### P4 — Do not leverage (wrong product, or Caffeine already better)

| InferDI choice | Why not in Caffeine |
|---|---|
| Ban decorators | HTTP/Kafka/scan are decorator-first |
| String/symbol-only keys | Class-as-token is the application UX |
| No multi-binding | Plugins, validators, interceptors need collections |
| No resolve hooks / AOP | Already used |
| No ALS in core | Controllers resolve without passing a scope |
| `Container<T>` widening as the only API | Decorators, scan, and `autoWire()` register off-chain; stale aliases; fights `rebind` and multi-bind |
| `{ fast: true }` second implementation | `init()` already compiles; a second path would drift |
| 3 KiB gzip budget | Would force deleting the product |
| No optional / object injection | `$i.optional` and `$i.object` are load-bearing in HTTP |
| Companion `lazyKey` as the only lazy | Caffeine’s `@Lazy` (eager skip) and `Provider` (re-resolve) cover different jobs |
| Child container as the only request scope | ALS is the framework integration |

---

## 8. Why not make `CaffeineIoC<T>` like `Container<T>`

This is the feature people will want after reading InferDI. It is also the one that would hurt Caffeine most.

**What you would gain.** `di.get(UnboundService)` becomes a type error. Scope inputs and async keys drop out of `get`. Modules can be checked against the accumulated graph.

**What you would pay.**

1. **Registration is not one chain.** `@Injectable` classes land in a global registrar. `scan()` imports files. `autoWire()` dumps them onto a container that was already constructed. There is no single returned `T` that includes them unless every decorator also threads a type-level registry — which Stage 3 decorators cannot do across files.

2. **Multi-bind and `.names()` / `.extends()`.** InferDI’s `T` is `key → one Spec`. Caffeine’s `get` / `getMany` / `$i.allOf` need `key → Binding[]`. A phantom `T` would have to model groups, primaries, and aliases. InferDI refused that complexity.

3. **`rebind`, profiles, conditionals.** The runtime graph after `init()` is not the registration-time graph. InferDI’s type is the registration-time graph and stays aligned because there is no compile phase that drops bindings.

4. **Stale aliases.** InferDI already warns that `const c = new Container(); c.registerClass(...)` leaves `c` with the old type. Caffeine’s `const di = new CaffeineIoC(); di.bind(...)` is the normal style. Widening returns would break every example and every `mod` `fn` that uses `c.bind` as `void`.

5. **HTTP already picked a different phantom.** `Router<GD, GP, R>` accumulates routes on the **return value**. That works because a route chain is authored in one expression. The DI graph is not.

A sane middle path: keep `CaffeineIoC` untyped as a bag of bindings, and add InferDI-style widening only on **local** builders (`mod` `fn` return types, `Binder` chains, `registerClass`-like helpers). That is 7.1 + 7.6, not a generic container.

---

## 9. Suggested order if Caffeine acts on this

1. **HTTP request-scope disposal** (7.3) — known bug, InferDI adapters are a worked example, no DI type-system change.
2. **`toClass` / `toSelf` positional typing** (7.1) — prototype on the binder; measure decorator fallout before touching `@Injectable`.
3. **`Symbol.dispose`** (7.4).
4. **Lifetime-narrowed `ResolutionContext`** (7.2) — design `Provider` as the legal escape, not InferDI’s ban.
5. **Typed `mod<Needs, Provides>`** (7.6) — optional, additive.
6. **Scope inputs or typed ALS inputs** (7.5) — only with HTTP maintainers; do not dump `ctx.state` into the container.
7. **Sequential dispose** (7.14) — if teardown order bugs appear.

Do not start a `CaffeineIoC<T>` rewrite. Do not import `@inferdi/inferdi` as the framework container.

---

## 10. Sources

**InferDI** (cloned from <https://github.com/inferdi/inferdi>, v6.0.2):

- `MANIFESTO.md` — pillars, non-goals, hot-path rules
- `packages/inferdi/src/Container.ts`, `src/index.ts`
- `packages/inferdi/README.md`, `MIGRATION.md`
- `apps/docs/src/core/*.md` (type-safety, scopes, lifetime-guards, lazy, modules, async, testing, scope-inputs)
- Adapter `packages/fastify|hono|koa|express|elysia/src/index.ts`
- `benchmarks/README.md` and `benchmarks/results/public-2026-08-17T16-46-00-483Z.json`

**CaffeineIoC** (this repo):

- `di/AGENTS.md`, `di/docs/**`, `di/container.ts`, `di/binder.ts`, `di/injection.ts`, `di/key.ts`, `di/decorators/injectable.ts`
- `http/AGENTS.md` (request scope vs streams)
- `ai/docs/di.md`

Not done: re-running InferDI’s benchmark suite against CaffeineIoC. If a performance comparison is needed, add Caffeine as a subject in InferDI’s harness or extend `benchmarks/di/compare_third_parties.bench.ts` — do not quote InferDI’s 1.00× table as if it included this repo.
