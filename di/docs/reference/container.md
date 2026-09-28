# Container

- [Constructor](#constructor)
  - [Options](#options)
- [Resolution](#resolution)
  - [get](#get)
  - [getOptional](#getoptional)
  - [getMany](#getmany)
  - [wrap](#wrap)
  - [wrapMany](#wrapmany)
- [Binding](#binding)
  - [bind](#bind)
  - [rebind](#rebind)
  - [bindConfig](#bindconfig)
  - [addProfiles](#addprofiles)
  - [overrides](#overrides)
- [Inspection](#inspection)
  - [getBinding](#getbinding)
  - [getBindings](#getbindings)
  - [getBindingsBy](#getbindingsby)
  - [getBindingsByLabel](#getbindingsbylabel)
  - [has](#has)
  - [hasScopeInGraph](#hasscopeingraph)
  - [entries](#entries)
  - [size](#size)
- [Lifecycle](#lifecycle)
  - [compile](#compile)
  - [init](#init)
  - [dispose](#dispose)
  - [resetInstances](#resetinstances)
  - [resetInstance](#resetinstance)
- [Ad-hoc Construction](#ad-hoc-construction)
  - [build](#build)
  - [builder](#builder)
- [Validation](#validation)
  - [assertResolvable](#assertresolvable)
- [Testing](#testing)
  - [snapshot](#snapshot)
  - [restore](#restore)
- [Properties](#properties)

---

## Constructor

```ts
new CaffeineIoC(options?: Partial<Options>)
```

Creates a new container. Nothing is registered yet: modules listed in
`options.modules` are queued, and every binding — decorated, bound by hand or
bound by a module — is registered when the container compiles, during
`compile()` / `init()`. Further modules can be appended with `addModules()`
until then.
When `decorators` is `true` (the default), the `@Injectable` and
`@Configuration` classes imported by the time the container compiles are
registered.

### Options

| Option                      | Type                        | Default                    | Description                                                                                                                                                                     |
| --------------------------- | --------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profiles`                  | `string[]`                  | `[]`                       | Active profiles. Bindings restricted with `@Profile` or `.profiles()` are included only when their profile is in this list. Can be extended with `addProfiles()` until compile. |
| `defaultScopeID`            | `NamedToken<Scope>`         | `Scopes.SINGLETON`         | Scope used for bindings that do not specify one.                                                                                                                                |
| `lazy`                      | `boolean`                   | `false`                    | When `true`, singletons are not instantiated during `init()` — they are created on first access.                                                                                |
| `checks.scopes`             | `ScopeCheckMode`            | `'compatible-scopes-only'` | Scope compatibility validation mode.                                                                                                                                            |
| `checks.circularReferences` | `boolean`                   | `true`                     | Detect circular dependencies during `init()`.                                                                                                                                   |
| `decorators`                | `boolean`                   | `true`                     | When `true`, registers the decorated classes when the container compiles. When `false`, decorators are ignored entirely, `bind()` included.                                     |
| `modules`                   | `Array<Module \| ModuleFn>` | `[]`                       | Modules to load during `compile()` / `init()`.                                                                                                                                  |

**`ScopeCheckMode`** values:

- `'compatible-scopes-only'` — a longer-lived binding cannot directly depend on a shorter-lived one.
- `'no-mix'` — all bindings in a dependency chain must share the same scope.
- `'off'` — no scope validation.

---

## Resolution

### get

```ts
get<T>(key: InjectionToken<T>): T
```

Resolves the binding for `key` and returns the instance.

Throws `ErrNoResolutionForKey` if no binding is registered for `key`.
Throws `ErrNoUniqueInjectionForKey` if multiple bindings exist for `key` and
none is marked `@Primary`.

```ts
const svc = di.get(UserService)
const logger = di.get(token<Logger>(Symbol.for('logger')))
```

### getOptional

```ts
getOptional<T>(key: InjectionToken<T>): T | undefined
```

Like `get()` but returns `undefined` instead of throwing when the key is not
found.

```ts
const cache = di.getOptional(CacheService) // undefined if not registered
```

### getMany

```ts
getMany<T>(key: InjectionToken<T>): T[]
```

Returns all instances bound to `key`. Throws `ErrNoResolutionForKey` if no
bindings exist.

```ts
const plugins = di.getMany<Plugin>(kPlugin)
```

### wrap

```ts
wrap<T>(key: InjectionToken<T>): Provider<T>
```

Returns a `Provider<T>` that lazily resolves `key` on every call to
`provider.get()`. Useful for injecting a longer-lived dependency on a
shorter-lived one without scope violation. The binding is looked up when
`wrap()` is called, so call it once the container has compiled.

```ts
const provider = di.wrap(HeavyService)
const instance = provider.get() // resolved lazily each time
```

### wrapMany

```ts
wrapMany<T>(key: InjectionToken<T>): Provider<T[]>
```

Like `wrap()` but resolves all bindings for `key` on each `provider.get()`.

---

## Binding

### bind

```ts
bind<K extends InjectionToken<any>>(key: K, configure: (spec: BindingSpec<TokenValue<K>, K>) => void): this
```

Describes a binding for `key` through the `BindingSpec` handed to `configure`. See the
[BindingSpec reference](./binding-spec.md) for the full fluent API.

Returns the container, so bindings chain:

```ts
di.bind(UserService, t => t.toSelf())
  .bind(Logger, t => t.toClass(ConsoleLogger))
  .bind(token<string>('version'), t => t.toValue('1.0.0'))
```

The binding is registered when the container compiles, not when `bind()` returns: until then
`has()`, `getBindings()` and `entries()` do not see it, and an invalid binding (an async one
marked lazy, say) is reported by `compile()` / `init()`. Called from a module, `bind()`
registers right away.

A key takes one binding. Binding a key that ends up with another binding — bound by hand,
bound by a module or decorated — fails the compilation with `ErrDuplicateBinding`, unless
profiles or conditions leave only one of them. Use `rebind()` to replace a binding.

Decorators are not read: a decorated class bound here gets only what its binding declares.

Once the container has registered its bindings — `compile()`, `init()` or `assertResolvable()`
has run — `bind()`, `rebind()` and `aspect()` throw `ErrInvalidContainerState`: a binding
declared then would miss its conditions, the overrides and the hooks.

### rebind

```ts
rebind<K extends InjectionToken<any>>(key: K, configure: (spec: BindingSpec<TokenValue<K>, K>) => void): this
```

Replaces everything that answers to `key`: the binding registered under it, however it was
made, and any binding named after it or extending it. Those keep resolving under their own
keys. `configure` receives the same `BindingSpec` that `bind()` provides.

It is the one way to replace a binding. Called before the container compiles, the replacement
is applied after the decorated bindings, the ones bound by hand and the modules' are
registered, so it replaces any of them. A key with no binding is simply bound.

```ts
di.rebind(Logger, t => t.toClass(StructuredLogger))
```

### bindConfig

```ts
bindConfig<T = unknown>(values: T): this
```

Sets the values that [`$i.config`](./injection.md#config) injections read, usually the
application's configuration. The container holds the object itself, not a copy and not a
binding: it does not count in `size` or show in `entries()`. An injection reads it when its
consumer is built, so a change made to the object in place reaches every consumer built
afterwards.

```ts
di.bindConfig<AppConfig>({ database: { host: 'localhost', port: 5432 } })
```

Calling it again replaces the values, and a module may call it too. Once the container has
compiled, it throws `ErrInvalidContainerState`: the `$i.config` injections compiled by then
already hold the values. Read them back with `values`, which throws `ErrNoValuesProvider` when
none were bound, and ask `hasValues` first when that is a possibility.

### addProfiles

```ts
addProfiles(profile: string, ...profiles: string[]): void
```

Adds profiles to the container's active set. Every binding is matched against
them when the container compiles, however it was made. Throws
`ErrInvalidContainerState` once the container has started compiling.

```ts
const di = new CaffeineIoC()
di.addProfiles('test', 'eu')
await di.init()
```

### overrides

```ts
overrides(override: ContainerOverride): this
```

Adds a step that changes the bindings once every one is registered and its
profiles and conditions are decided, and before any is resolved. Overrides run
in the order they were added, when the container compiles, and reach a binding
however it was made. `TestContainer` is built on it.

The step receives `OverrideOps`: `entries()`, `getBindings()` and `has()` to
read the bindings, `bind()` and `rebind()` to add or replace one, and
`unbind(key)` to remove the binding registered under `key`. A binding a step
adds is decided right after it, profiles and conditions included. Throws
`ErrInvalidContainerState` once the container has started compiling.

```ts
di.overrides(ops => {
  ops.unbind(MailSender)
  ops.rebind(Clock, t => t.toValue(fixedClock))
})
```

---

## Inspection

Nothing is registered before the container compiles, so these read an empty
container until `compile()`, `init()` or `assertResolvable()` has run.

### getBinding

```ts
getBinding<T>(key: InjectionToken<T>): Binding<T> | undefined
```

Returns the `Binding` descriptor for `key`, or `undefined` if not found.

### getBindings

```ts
getBindings<T>(key: InjectionToken<T>): Binding<T>[]
```

Returns all `Binding` descriptors for `key`. Returns an empty array if none
exist.

### getBindingsBy

```ts
getBindingsBy(predicate: (descriptor: BindingDescriptor) => boolean): BindingDescriptor[]
```

Returns all bindings for which `predicate` returns `true`.

```ts
const singletons = di.getBindingsBy(d => d.binding.scopeID === Scopes.SINGLETON)
```

### getBindingsByLabel

```ts
getBindingsByLabel(label: symbol): BindingDescriptor[]
```

Returns all bindings whose `labels` array contains `label`.

```ts
const controllers = di.getBindingsByLabel(Symbol.for('controller'))
```

### has

```ts
has<T>(key: InjectionToken<T>): boolean
```

Returns `true` if a binding is registered for `key`.

### hasScopeInGraph

```ts
hasScopeInGraph(key: InjectionToken, scopeID: NamedToken<Scope>): boolean
```

Returns `true` if any binding in the transitive dependency graph of `key` uses
the given scope.

### entries

```ts
entries(): IterableIterator<[InjectionToken, Binding]>
```

Returns an iterator over all `[key, binding]` pairs in the container. Use this
to feed `buildBindingGraph()` from `@caffeinejs/di/graph`.

### size

```ts
readonly size: number
```

The number of bindings registered in the container.

---

## Lifecycle

### compile

```ts
compile(): Promise<void>
```

Registers every binding and prepares it for resolution, without creating
instances. In order: the decorated bindings, the bindings declared with `bind()`
and `aspect()`, the modules' bindings, the `rebind()` replacements, the
conditions, the `overrides()` steps, then the graph checks and the compilation of
the factories. Profiles are matched as each binding is registered.

`init()` runs it when it has not run yet. Every later call returns the same
compilation, its failure included. Throws `ErrDuplicateBinding` when a key ends
up with more than one binding.

### init

```ts
init(): Promise<void>
```

Initializes the container: validates the dependency graph, compiles injection
resolvers, and eagerly instantiates non-lazy singletons.

**Must be called before any resolution.** Calling `get()` before `init()`
throws `ErrInvalidContainerState`.

```ts
const di = new CaffeineIoC({ modules: [appModule] })
await di.init()
```

### dispose

```ts
dispose(): Promise<void>
```

Destroys the container. Runs destroy hooks (an `OnDestroy` class's `onDestroy()`,
an `@OnLifecycle` `destroy` callback, `.preDestroy()`) on every cached instance in
reverse creation order, one at a time, and once per instance — two bindings
holding the same object destroy it once. Hooks that throw do not stop the rest;
they are reported together as an `AggregateError`.

The container also implements `Symbol.asyncDispose`, so `await using di = new CaffeineIoC(...)`
disposes it when the block exits. It is a direct alias of `dispose()` — same hooks, same
order, same `AggregateError` on failure. There is no synchronous `Symbol.dispose`.

### resetInstances

```ts
resetInstances(): Promise<void>
```

Resets all instances. On the next resolution, fresh
instances are created.

> Note that async bindings are automatically reloaded after being disposed.

### resetInstance

```ts
resetInstance(key: InjectionToken): Promise<void>
```

Resets the bindings associated with the given key.

> Note that async bindings are automatically reloaded after being disposed.

---

## Ad-hoc Construction

### build

```ts
build<T>(ctor: Ctor<T>, injections?: Injection[]): T
```

Constructs a class instance outside of the container's binding registry. The
`injections` list is resolved from the container. Useful for constructing
request-level objects without registering them.

```ts
const handler = di.build(RequestHandler, [RequestContext])
```

### builder

```ts
builder<T>(ctor: Ctor<T>, injections?: Injection[]): () => T
```

Returns a compiled factory function that creates instances of `ctor` using
dependencies from the container. Faster than calling `build()` in a hot path.

---

## Validation

### assertResolvable

```ts
assertResolvable(): Promise<void>
```

Verifies that every binding in the container can be resolved: all required
dependencies exist, and there are no missing keys. Throws
`ErrUnresolvableDependencies` listing every violation, not only the first.

It registers the bindings first, as `compile()` does, without compiling them, so
call it before `init()`: `init()` fails on the first missing dependency. Once it
has run, the container takes no more bindings.

```ts
await di.assertResolvable()
await di.init()
```

---

## Testing

### snapshot

```ts
snapshot(): Snapshot
```

Captures what the container was told to hold, as a `Snapshot`: the bindings
declared with `bind()`, `rebind()` and `aspect()`, its modules, its profiles,
whether it registers decorated bindings, and the values bound with
`bindConfig()`. The container's own bindings (`Keys.kRefresher`,
`Keys.kRequestScopeManager`) are left out: every container binds its own. Does
not include instance state.

It is not the registry. A container restored from it registers the decorated
bindings, runs the modules and decides profiles and conditions itself, so a
snapshot taken before `init()` and one taken after restore to the same
bindings.

### restore

```ts
restore(snap: Snapshot): void
```

Adds what `snap` holds to the container: its declarations, after the ones
already made, its modules and its profiles. The container registers decorated
bindings when the snapshot's container did. When `snap` carries values, they
replace the container's values too. Throws `ErrInvalidContainerState` once the
container has started compiling.

---

## Properties

| Property              | Type                  | Description                                                 |
| --------------------- | --------------------- | ----------------------------------------------------------- |
| `ready`               | `boolean`             | `true` after `init()` completes.                            |
| `size`                | `number`              | Number of bindings registered.                              |
| `profiles`            | `ReadonlySet<string>` | Active profiles.                                            |
| `hooks`               | `HookListener`        | Container lifecycle event emitter. See [Hooks](./hooks.md). |
| `postProcessors`      | `Set<PostProcessor>`  | Post-init hooks run on every instance.                      |
| `refresher`           | `Refresher`           | Controls `REFRESH` scope resets.                            |
| `requestScopeManager` | `RequestScopeManager` | Controls `REQUEST` scope contexts.                          |
| `values`              | `unknown`             | The values from `bindConfig()`. Throws if unset.            |
| `hasValues`           | `boolean`             | Whether `bindConfig()` was called.                          |
