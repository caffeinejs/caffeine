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
  - [autoWire](#autowire)
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
  - [init](#init)
  - [dispose](#dispose)
  - [resetInstances](#resetinstances)
  - [resetInstance](#resetinstance)
- [Ad-hoc Construction](#ad-hoc-construction)
  - [build](#build)
  - [builder](#builder)
- [Validation](#validation)
  - [assertResolvable](#assertresolvable)
- [Hierarchy](#hierarchy)
  - [newChild](#newchild)
  - [parent](#parent)
- [Testing](#testing)
  - [snapshot](#snapshot)
  - [restore](#restore)
- [Properties](#properties)

---

## Constructor

```ts
new DiCaf(...modules: Module[])
new DiCaf(options: Options, ...modules: Module[])
```

Creates a new container and immediately applies every module passed to it.
When `decorators` is `true` (the default), `autoWire()` is called in the
constructor to pick up all `@Injectable` classes registered so far.

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `profiles` | `Identifier[]` | `[]` | Active profiles. Bindings annotated with `@Profile` are included only when their profile is in this list. |
| `defaultScopeId` | `Identifier` | `Scopes.SINGLETON` | Scope used for bindings that do not specify one. |
| `parent` | `Container` | — | Parent container. Unresolved keys are looked up in the parent. |
| `lazy` | `boolean` | `false` | When `true`, singletons are not instantiated during `init()` — they are created on first access. |
| `metadataReader` | `MetadataReader` | — | Custom reader for overriding binding defaults from external metadata. |
| `checks.scopes` | `ScopeCheckMode` | `'compatible-scopes-only'` | Scope compatibility validation mode. |
| `checks.circularReferences` | `boolean` | `true` | Detect circular dependencies during `init()`. |
| `decorators` | `boolean` | `true` | When `true`, calls `autoWire()` automatically in the constructor. |

**`ScopeCheckMode`** values:

- `'compatible-scopes-only'` — a longer-lived binding cannot directly depend on a shorter-lived one.
- `'no-mix'` — all bindings in a dependency chain must share the same scope.
- `'off'` — no scope validation.

---

## Resolution

### get

```ts
get<T>(key: Key<T>): T
```

Resolves the binding for `key` and returns the instance.

Throws `ErrNoResolutionForKey` if no binding is registered for `key`.
Throws `ErrNoUniqueInjectionForKey` if multiple bindings exist for `key` and
none is marked `@Primary`.

```ts
const svc = di.get(UserService)
const logger = di.get<Logger>(Symbol.for('logger'))
```

### getOptional

```ts
getOptional<T>(key: Key<T>): T | undefined
```

Like `get()` but returns `undefined` instead of throwing when the key is not
found.

```ts
const cache = di.getOptional(CacheService) // undefined if not registered
```

### getMany

```ts
getMany<T>(key: Key<T>): T[]
```

Returns all instances bound to `key`. Throws `ErrNoResolutionForKey` if no
bindings exist.

```ts
const plugins = di.getMany<Plugin>(kPlugin)
```

### wrap

```ts
wrap<T>(key: Key<T>): Provider<T>
```

Returns a `Provider<T>` that lazily resolves `key` on every call to
`provider.get()`. Useful for injecting a longer-lived dependency on a
shorter-lived one without scope violation.

```ts
const provider = di.wrap(HeavyService)
const instance = provider.get() // resolved lazily each time
```

### wrapMany

```ts
wrapMany<T>(key: Key<T>): Provider<T[]>
```

Like `wrap()` but resolves all bindings for `key` on each `provider.get()`.

---

## Binding

### bind

```ts
bind<T>(key: Key<T>): Binder<T>
```

Opens a new binding for `key` and returns a `Binder` to configure it. See the
[Binder reference](./binder.md) for the full fluent API.

```ts
di.bind(UserService).toSelf()
di.bind(Logger).toClass(ConsoleLogger)
di.bind('version').toValue('1.0.0')
```

### rebind

```ts
rebind<T>(key: Key<T>): Binder<T>
```

Removes any existing binding for `key`, then opens a new binding. The
resulting `Binder` is identical to the one returned by `bind()`.

```ts
di.rebind(Logger).toClass(StructuredLogger)
```

### autoWire

```ts
autoWire(): void
```

Picks up all classes decorated with `@Injectable` that are registered in the
global decorator registry and adds them to this container. Called automatically
in the constructor when `decorators: true`.

Call it manually if you decorated classes are imported after the container was
created.

---

## Inspection

### getBinding

```ts
getBinding<T>(key: Key<T>): Binding<T> | undefined
```

Returns the `Binding` descriptor for `key`, or `undefined` if not found.

### getBindings

```ts
getBindings<T>(key: Key<T>): Binding<T>[]
```

Returns all `Binding` descriptors for `key`. Returns an empty array if none
exist.

### getBindingsBy

```ts
getBindingsBy(predicate: (descriptor: BindingDescriptor) => boolean): BindingDescriptor[]
```

Returns all bindings for which `predicate` returns `true`.

```ts
const singletons = di.getBindingsBy(d => d.binding.scopeId === Scopes.SINGLETON)
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
has<T>(key: Key<T>): boolean
```

Returns `true` if a binding is registered for `key`.

### hasScopeInGraph

```ts
hasScopeInGraph(key: Key, scopeId: Identifier): boolean
```

Returns `true` if any binding in the transitive dependency graph of `key` uses
the given scope.

### entries

```ts
entries(): IterableIterator<[Key, Binding]>
```

Returns an iterator over all `[key, binding]` pairs in the container. Use this
to feed `buildBindingGraph()`.

### size

```ts
readonly size: number
```

The number of bindings registered in the container.

---

## Lifecycle

### init

```ts
init(): Promise<void>
```

Initializes the container: validates the dependency graph, compiles injection
resolvers, and eagerly instantiates non-lazy singletons.

**Must be called before any resolution.** Calling `get()` before `init()` may
return `undefined` or throw.

```ts
const di = new DiCaf(appModule)
await di.init()
```

### dispose

```ts
dispose(): Promise<void>
```

Destroys the container. Runs `@PreDestroy` hooks on all singleton instances in
reverse initialization order.

### resetInstances

```ts
resetInstances(): Promise<void>
```

Resets all instances. On the next resolution, fresh
instances are created.  
> Note that async bindings are automatically reloaded after being disposed.

### resetInstance

```ts
resetInstance(key: Key): Promise<void>
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
assertResolvable(): void
```

Verifies that every binding in the container can be resolved: all required
dependencies exist, and there are no missing keys. Throws descriptively on the
first violation found.

Call this after `init()` as a startup health check:

```ts
await di.init()
di.assertResolvable()
```

---

## Hierarchy

### newChild

```ts
newChild(): Container
```

Creates a child container that inherits all bindings from the parent. The child
can register additional bindings or override existing ones without affecting the
parent.

Child containers must also be initialized with `await child.init()`.

```ts
const parent = new DiCaf(sharedModule)
await parent.init()

const child = parent.newChild()
child.bind(TenantConfig).toValue(config)
await child.init()
```

### parent

```ts
readonly parent?: Container
```

The parent container, if this is a child container.

---

## Testing

### snapshot

```ts
snapshot(): Snapshot
```

Captures the current set of bindings as a `Snapshot`. Does not include
instance state.

### restore

```ts
restore(snap: Snapshot): void
```

Replaces the container's bindings with those from `snap`. All existing
instances are discarded.

---

## Properties

| Property | Type | Description |
|---|---|---|
| `ready` | `boolean` | `true` after `init()` completes. |
| `size` | `number` | Number of bindings registered. |
| `profiles` | `ReadonlySet<Identifier>` | Active profiles. |
| `parent` | `Container \| undefined` | Parent container. |
| `hooks` | `HookListener` | Container lifecycle event emitter. See [Hooks](./hooks.md). |
| `postProcessors` | `Set<PostProcessor>` | Post-init hooks run on every instance. |
| `refresher` | `Refresher` | Controls `REFRESH` scope resets. |
| `requestScopeManager` | `RequestScopeManager` | Controls `REQUEST` scope contexts. |
