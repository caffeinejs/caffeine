---
sidebar_label: Injection Resolvers
---

# Injection Resolvers

- [InjectionResolver](#injectionresolver)
- [InjectionResolverFactory](#injectionresolverfactory)
- [InjectionResolverFactoryContext](#injectionresolverfactorycontext)
- [BuiltInResolvers](#builtinresolvers)
- [Functions](#functions)
  - [bindResolver](#bindresolver)
  - [unbindResolver](#unbindresolver)
  - [hasResolver](#hasresolver)

All types and functions are exported from the main package:

```ts
import {
  BuiltInResolvers,
  bindResolver,
  unbindResolver,
  hasResolver,
  type InjectionResolver,
  type InjectionResolverFactory,
  type InjectionResolverFactoryContext,
} from '@caffeinejs/core'
```

An **injection resolver** is a low-level extension point. When the container
resolves a dependency, it picks a resolver factory based on the `resolver` symbol
stored in the `InjectionDescriptor`, calls the factory to build a resolver
function, then calls that resolver to produce the value. Custom resolvers let you
plug in resolution strategies beyond the built-in set.

---

## InjectionResolver

```ts
type InjectionResolver<T = any> = () => T
```

A zero-argument function that returns the resolved value. The container calls it
once per resolution — for singleton scopes that is exactly once; for transient
scopes it is once per `get()` call.

---

## InjectionResolverFactory

```ts
type InjectionResolverFactory<T = unknown> =
  (ctx: InjectionResolverFactoryContext<T>) => InjectionResolver<T>
```

A factory that receives context about the injection site and returns an
`InjectionResolver`. Registered with `bindResolver()` and identified by a unique
symbol.

---

## InjectionResolverFactoryContext

```ts
type InjectionResolverFactoryContext<T = unknown> = {
  readonly container: ContainerOps
  readonly descriptor: InjectionDescriptor<T>
  readonly key?: Key<T>
  readonly kind: 'constructor' | 'property' | 'method'
  readonly member: Identifier
  readonly index: number
}
```

Passed to every `InjectionResolverFactory` when the container wires an injection
site.

| Property | Description |
|---|---|
| `container` | The container instance. Use it to call `get()`, `getMany()`, or `has()` during resolver setup. |
| `descriptor` | The full `InjectionDescriptor` for this injection, including `key`, `optional`, `multiple`, and any custom `args`. |
| `key` | The key of the **component** that declares this injection (i.e. the class that has the dependency, not the dependency itself). |
| `kind` | Where the injection appears: constructor parameter, class property, or method parameter. |
| `member` | The member name for property and method injections. Empty string for constructor injections. |
| `index` | Parameter position for constructor and method injections. `-1` when position is not tracked. |

---

## BuiltInResolvers

```ts
const BuiltInResolvers = {
  DEFAULT:  Symbol('@caffeinejs/core:resolver.default'),
  MAP:      Symbol('@caffeinejs/core:resolver.map'),
  DEFER:    Symbol('@caffeinejs/core:resolver.defer'),
  OBJECT:   Symbol('@caffeinejs/core:resolver.object'),
  PROVIDER: Symbol('@caffeinejs/core:resolver.provider'),
  VALUE:    Symbol('@caffeinejs/core:resolver.value'),
} as const
```

Symbols for the built-in resolver factories. These are the resolver identifiers
used by the injection helpers in the [Injection reference](./injection.md):

| Symbol | Used by |
|---|---|
| `DEFAULT` | Plain key injection — the resolver used when no `resolver` field is set. |
| `MAP` | `mapped()` |
| `DEFER` | `defer()` |
| `OBJECT` | `object()` |
| `PROVIDER` | `provide()` |
| `VALUE` | `useValue()` |

---

## Functions

### bindResolver

```ts
bindResolver(name: symbol, factory: InjectionResolverFactory): void
```

Registers a custom resolver factory under `name`. Once registered, any
`InjectionDescriptor` whose `resolver` field matches `name` will use this
factory.

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
@Injectable([{ key: ConfigKey, resolver: kUpperCase }])
class Service {
  constructor(readonly label: string) {}
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
