# Binder

- [Binder](#binder-1)
  - [toClass](#toclass)
  - [toSelf](#toself)
  - [toValue](#tovalue)
  - [toFactory](#tofactory)
  - [toAsyncFactory](#toasyncfactory)
  - [toFunction](#tofunction)
  - [aliasOf](#aliasof)
- [BinderOptions](#binderoptions)
  - [lifetime](#lifetime)
  - [names](#names)
  - [lazy](#lazy)
  - [primary](#primary)
  - [fallback](#fallback)
  - [byPassPostProcessors](#bypasspostprocessors)
  - [injectProperty](#injectproperty)
  - [injectMethod](#injectmethod)
  - [labels](#labels)
  - [tags](#tags)
  - [postConstruct](#postconstruct)
  - [preDestroy](#predestroy)
  - [intercept](#intercept)
  - [conditional](#conditional)
  - [profiles](#profiles)
  - [extends](#extends)
  - [internal](#internal)

---

## Binder

`Binder<TValue>` is obtained from `di.bind(key)` or `di.rebind(key)`. Its
methods select *how* the key is resolved. Each method returns a
`BinderOptions<TValue>` for further configuration.

### toClass

```ts
toClass(constructor, injections?)
```

Resolves the key by instantiating `constructor`. Dependencies in `injections`
are resolved from the container and passed to the constructor in order.

```ts
di.bind(UserService).toClass(UserService, [Logger, Database])
```

When `injections` is omitted the container injects nothing. Use decorator
metadata or an explicit injection array.

### toSelf

```ts
toSelf(injections?)
```

Shorthand for `toClass(key, injections)` when the key is a class reference.

```ts
di.bind(UserService).toSelf([Logger])
```

### toValue

```ts
toValue(value)
```

Binds the key to a constant value. The value is returned as-is on every
resolution.

```ts
const kAppVersion = token<string>('app.version')
di.bind(kAppVersion).toValue('1.0.0')
di.bind(AppConfig).toValue(config)
```

### toFactory

```ts
toFactory(factory)
```

Binds the key to a synchronous factory function. The factory receives a
`ResolutionContext` and must return the instance synchronously.

```ts
di.bind(Logger).toFactory(ctx => new ConsoleLogger(ctx.container.get(AppConfig)))
```

### toAsyncFactory

```ts
toAsyncFactory(factory)
```

Binds the key to an async factory function that returns a `Promise`. The
container awaits the promise during `init()`.

```ts
di.bind(DatabasePool).toAsyncFactory(async ctx => {
  const cfg = ctx.container.get(AppConfig)
  return connectToDatabase(cfg.databaseUrl)
})
```

### toFunction

```ts
toFunction(fn, injections?)
```

Binds the key to the *result* of calling `fn` with resolved dependencies.
Unlike `toFactory`, the function does not receive a `ResolutionContext` — it
receives the resolved dependency values directly.

```ts
di.bind(Greeter).toFunction(
  (name: string) => `Hello, ${name}!`,
  ['app.name'],
)
```

### aliasOf

```ts
aliasOf(key)
```

Registers the key as an alias for another key. Resolving the key is identical
to resolving the target.

```ts
di.bind(IUserService).aliasOf(UserServiceImpl)
```

---

## BinderOptions

`BinderOptions<TValue>` is returned by every `Binder` terminal method. Its
methods are chainable and configure the binding's metadata. Calling any method
returns the same `BinderOptions` instance.

### lifetime

```ts
lifetime(scopeId)
```

Sets the lifecycle scope for the binding. See [Scopes](./scopes.md) for
available scope identifiers.

```ts
di.bind(CacheService).toSelf().lifetime(Scopes.SINGLETON)
di.bind(RequestLogger).toSelf().lifetime(Scopes.REQUEST)
```

### names

```ts
names(name, ...names)
```

Registers additional string or symbol keys for the binding. The binding is
accessible under the primary key and all named keys.

```ts
di.bind(Logger)
  .toClass(ConsoleLogger)
  .names('default-logger', Symbol.for('logger'))
```

### lazy

```ts
lazy(boolean?)
```

When `true`, defers instantiation until first resolution instead of during
`init()`. Default: `false`.

```ts
di.bind(HeavyService).toSelf().lazy()
```

### primary

```ts
primary(boolean?)
```

Marks this binding as the preferred one when multiple bindings exist for the
same key. `di.get()` returns this binding instead of throwing
`ErrNoUniqueInjectionForKey`.

```ts
di.bind(Logger).toClass(FileLogger).primary()
```

### fallback

```ts
fallback(boolean?)
```

Marks this binding as a fallback. It is only used when no non-fallback binding
exists for the same key.

```ts
di.bind(Metrics).toClass(NoOpMetrics).fallback()
```

### byPassPostProcessors

```ts
byPassPostProcessors()
```

Excludes this binding from all `PostProcessor` hooks.

### injectProperty

```ts
injectProperty(property, injection)
```

Injects a dependency into a property of the resolved instance after
construction.

```ts
di.bind(Service).toSelf().injectProperty('logger', Logger)
```

### injectMethod

```ts
injectMethod(method, ...deps)
```

Calls `method` on the resolved instance after construction, passing resolved
dependencies as arguments.

```ts
di.bind(Service).toSelf().injectMethod('setLogger', Logger)
```

### labels

```ts
labels(symbol, ...symbols)
```

Attaches symbol labels to the binding. Labels enable grouped retrieval via
`di.getBindingsByLabel(label)`.

```ts
const kPlugin = Symbol.for('plugin')
di.bind(AuthPlugin).toSelf().labels(kPlugin)
```

### tags

```ts
tags(symbol, value)
tags(map)
```

Attaches symbol-keyed metadata to the binding. Useful for runtime introspection.

```ts
di.bind(UserController).toSelf().tags(Symbol.for('route'), '/api/users')
```

### postConstruct

```ts
postConstruct(fn)
```

Runs `fn` immediately after the instance is created. Must be synchronous; the container does not await a returned promise.

```ts
di.bind(DatabasePool)
  .toSelf()
  .postConstruct(pool => pool.connect())
```

### preDestroy

```ts
preDestroy(fn)
```

Runs `fn` before the instance is destroyed during `dispose()`.

```ts
di.bind(DatabasePool)
  .toSelf()
  .preDestroy(pool => pool.end())
```

### intercept

```ts
intercept(interceptor)
```

Wraps every resolved instance with `interceptor`. The interceptor receives the
`ResolutionContext` and the instance and must return the (possibly wrapped)
instance.

```ts
di.bind(PaymentService)
  .toSelf()
  .intercept((ctx, instance) => withMetrics(instance))
```

### conditional

```ts
conditional(fn)
```

Activates the binding only when all predicates in `fn` return `true`.
Predicates receive a `ConditionContext` with `container.has()`.

```ts
di.bind(RedisCacheService)
  .toSelf()
  .conditional(ctx => ctx.container.has(RedisClient))
```

### profiles

```ts
profiles(profile, ...profiles)
```

Restricts this binding to the given profiles. The binding is only active when
one of them is enabled on the container.

```ts
di.bind(MockEmailService).toSelf().profiles('test', 'development')
```

### extends

```ts
extends(constructor?)
```

Registers the binding under an abstract base class in addition to its primary
key. When no `constructor` is given, the base is inferred from the class's
prototype chain.

```ts
di.bind(ConsoleLogger).toSelf().extends(Logger)
di.get(Logger) // ConsoleLogger
```

### internal

```ts
internal()
```

Marks the binding as internal. Internal bindings are excluded from
`getBindings()`, `getBindingsBy()`, and `getBindingsByLabel()` results when
called from outside the container's own resolution logic.
