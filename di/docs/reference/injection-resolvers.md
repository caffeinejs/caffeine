---
sidebar_label: Injection Resolvers
---

# Injection Stages and Resolvers

- [How an injection resolves](#how-an-injection-resolves)
- [InjectionResolver](#injectionresolver)
- [InjectionContext](#injectioncontext)
- [InjectionMiddleware](#injectionmiddleware)
- [BuiltInStages](#builtinstages)
- [Stage functions](#stage-functions)
  - [registerStage](#registerstage)
  - [unregisterStage](#unregisterstage)
  - [hasStage](#hasstage)
- [Custom resolvers](#custom-resolvers)
  - [InjectionResolverFactory](#injectionresolverfactory)
  - [InjectionResolverFactoryContext](#injectionresolverfactorycontext)
  - [bindResolver](#bindresolver)
  - [unbindResolver](#unbindresolver)
  - [hasResolver](#hasresolver)

All types and functions are exported from the main package:

```ts
import {
  BuiltInStages,
  bindResolver,
  hasResolver,
  hasStage,
  registerStage,
  unbindResolver,
  unregisterStage,
  type InjectionContext,
  type InjectionMiddleware,
  type InjectionResolver,
  type InjectionResolverFactory,
  type InjectionResolverFactoryContext,
} from '@caffeinejs/di'
```

---

## How an injection resolves

An `InjectionDescriptor` names **stages**. When the container compiles, it folds them into a single
`InjectionResolver` and calls that on every resolution. The fold happens once; the stages are not
walked again.

The bindings selected for the injection travel down the chain, so a stage can rearrange them before
anything is built. Each stage acts in one of three ways:

| Acts by       | Doing                                               | Used by                                      |
| ------------- | --------------------------------------------------- | -------------------------------------------- |
| transforming  | changing `ctx.bindings`, then returning `next(...)` | `ordered`                                    |
| wrapping      | wrapping the resolver `next` returns                | `provide`                                    |
| materializing | ignoring `next` and producing the resolver          | `allOf`, `mapped`, `just`, `value`, `object` |

The third kind is **terminal**: it decides what the injection resolves to. A chain accepts exactly one,
and a second throws `ErrConflictingInjectionStages` naming both — `allOf(mapped(key))` asks for an array
and a map at once, so it is refused.

Stages keep the order they were written in, except that the terminal always runs last. That is why
nesting order does not matter:

```ts
$i.ordered($i.provide(kPlugin)) // Provider<Plugin[]>
$i.provide($i.ordered(kPlugin)) // the same chain, the same result
```

`optional` is a flag rather than a stage, because only the terminal knows what an empty selection means:
`undefined` for `mapped`, an empty array for `allOf`.

---

## InjectionResolver

```ts
type InjectionResolver<T = any> = () => T
```

A zero-argument function that returns the resolved value. The container calls it once per resolution —
for singleton scopes that is effectively once; for transient scopes it is once per `get()` call.

---

## InjectionContext

```ts
interface InjectionContext<T = unknown> extends InjectionResolverFactoryContext<T> {
  readonly bindings: readonly Binding<unknown>[]
}
```

What a stage receives. It is an [InjectionResolverFactoryContext](#injectionresolverfactorycontext) plus
the bindings selected so far, which is what lets `ordered` sort them before any instance exists — order
lives on the `Binding`, not on the value. `bindings` is empty for an injection that resolves without a
key, such as a constant.

---

## InjectionMiddleware

```ts
type InjectionMiddleware<T = unknown> = (
  ctx: InjectionContext<T>,
  next: (ctx: InjectionContext<T>) => InjectionResolver<T>,
  args?: unknown,
) => InjectionResolver<T>
```

One stage. `args` is whatever the descriptor stored alongside the stage name.

Because the chain is folded at compile time and `next` returns the finished resolver, a stage that only
rearranges bindings costs nothing per resolution — provided it returns `next(...)` unchanged instead of
wrapping it, and hoists anything it allocates out of the resolver it returns:

```ts
// correct — the wrapper is built once
const providerStage: InjectionMiddleware = (ctx, next) => {
  const inner = next(ctx)
  const provider = { get: inner }

  return () => provider
}

// wrong — allocates on every resolution
const providerStage: InjectionMiddleware = (ctx, next) => {
  const inner = next(ctx)

  return () => ({ get: inner })
}
```

---

## BuiltInStages

```ts
const BuiltInStages = {
  CONFIG: Symbol('@caffeinejs/di:stage.config'),
  MANY: Symbol('@caffeinejs/di:stage.many'),
  MAP: Symbol('@caffeinejs/di:stage.map'),
  OBJECT: Symbol('@caffeinejs/di:stage.object'),
  PROVIDER: Symbol('@caffeinejs/di:stage.provider'),
  SORT: Symbol('@caffeinejs/di:stage.sort'),
  VALUE: Symbol('@caffeinejs/di:stage.value'),
} as const
```

The stages every container starts with, named by the injection helpers in the
[Injection reference](./injection.md):

| Symbol     | Terminal | Named by                   |
| ---------- | -------- | -------------------------- |
| `SORT`     | no       | `ordered()`                |
| `PROVIDER` | no       | `provide()`                |
| `MANY`     | yes      | `allOf()`, and `ordered()` |
| `MAP`      | yes      | `mapped()`                 |
| `OBJECT`   | yes      | `object()`                 |
| `VALUE`    | yes      | `just()`                   |
| `CONFIG`   | yes      | `value()`                  |

A chain that names no terminal resolves the single binding for its key. `defer()` names no stage at all:
it makes the key a `DeferredCtor`, which the chain unwraps when it selects bindings.

---

## Stage functions

### registerStage

```ts
registerStage(name: symbol, middleware: InjectionMiddleware, options?: { terminal?: boolean }): void
```

Registers a stage under a name a descriptor can reference. Pass `terminal: true` for a stage that decides
what the injection resolves to.

```ts
const kFirstOnly = Symbol('my-app.stage.first-only')

// A transforming stage: it narrows the bindings and hands the rest of the chain straight back.
registerStage(kFirstOnly, (ctx, next) => next({ ...ctx, bindings: ctx.bindings.slice(0, 1) }))

@Injectable([{ key: kPlugin, stages: [{ name: kFirstOnly }, { name: BuiltInStages.MANY }] } as never])
class Service {
  constructor(readonly plugins: Plugin[]) {}
}
```

Throws `ErrInjectionStageAlreadyRegistered` if `name` is already registered.

---

### unregisterStage

```ts
unregisterStage(name: symbol): void
```

Removes the stage registered under `name`. No-op if `name` is not registered.

---

### hasStage

```ts
hasStage(name: symbol): boolean
```

Returns `true` if a stage is registered under `name`.

---

## Custom resolvers

`bindResolver` registers a whole resolver rather than a stage. A descriptor names it through `resolver`
instead of `stages`, and it acts as that injection's terminal. Wrapping stages still compose over it —
list them in the same descriptor — while naming a terminal stage as well is a conflict.

An injection list is typed as tokens and `$i` helper results, so a hand-written descriptor needs a cast
to appear in one. That is deliberate: it keeps `{ key: Service }` from looking like an injection when it
is really a plain object.

### InjectionResolverFactory

```ts
type InjectionResolverFactory<T = unknown> = (ctx: InjectionResolverFactoryContext<T>) => InjectionResolver<T>
```

A factory that receives context about the injection site and returns an `InjectionResolver`. Registered
with `bindResolver()` and identified by a unique symbol.

---

### InjectionResolverFactoryContext

```ts
type InjectionResolverFactoryContext<T = unknown> = {
  readonly container: ContainerOps
  readonly descriptor: InjectionDescriptor<T>
  readonly key?: InjectionToken<T>
  readonly kind: 'constructor' | 'property' | 'method'
  readonly member: Identifier
  readonly index: number
}
```

Passed to every `InjectionResolverFactory` when the container wires an injection site.

| Property     | Description                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `container`  | The container instance. Use it to call `get()`, `getMany()`, or `has()` during resolver setup.                                 |
| `descriptor` | The full `InjectionDescriptor` for this injection, including `key`, `optional`, `stages`, and `resolver`.                      |
| `key`        | The key of the **component** that declares this injection (i.e. the class that has the dependency, not the dependency itself). |
| `kind`       | Where the injection appears: constructor parameter, class property, or method parameter.                                       |
| `member`     | The member name for property and method injections. Empty string for constructor injections.                                   |
| `index`      | Parameter position for constructor and method injections. `-1` when position is not tracked.                                   |

---

### bindResolver

```ts
bindResolver(name: symbol, factory: InjectionResolverFactory): void
```

Registers a custom resolver factory under `name`. Once registered, any `InjectionDescriptor` whose
`resolver` field matches `name` will use this factory.

```ts
const kUpperCase = Symbol('my-app.resolver.uppercase')

bindResolver(kUpperCase, ctx => {
  const key = ctx.descriptor.key!
  return () => {
    const value = ctx.container.get<string>(key)
    return value.toUpperCase()
  }
})

// use the resolver in an injection descriptor
@Injectable([{ key: ConfigKey, resolver: kUpperCase } as never])
class Service {
  constructor(readonly label: string) {}
}

// and compose a wrapping stage over it
@Injectable([{ key: ConfigKey, resolver: kUpperCase, stages: [{ name: BuiltInStages.PROVIDER }] } as never])
class LazyService {
  constructor(readonly label: Provider<string>) {}
}
```

Throws `ErrResolverAlreadyRegistered` if `name` is already registered.

---

### unbindResolver

```ts
unbindResolver(name: symbol): void
```

Removes the resolver registered under `name`. No-op if `name` is not registered.

---

### hasResolver

```ts
hasResolver(name: symbol): boolean
```

Returns `true` if a resolver factory is registered under `name`.

```ts
if (!hasResolver(kUpperCase)) {
  bindResolver(kUpperCase, factory)
}
```
