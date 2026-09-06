---
sidebar_label: Decorators
---

# Decorators

All decorators are exported from:

- **Stage 3 Decorators**: `@caffeinejs/di/decorators`
- **Legacy TypeScript Decorators**: `@caffeinejs/di/decorators/legacy`

```ts
import { Injectable, Lifetime, Inject } from '@caffeinejs/di/decorators'

// or

import { Injectable, Lifetime, Inject } from '@caffeinejs/di/decorators/legacy'
```

CaffeineIoC ships two decorator flavours. This document focus on **stage 3 decorators**
(TypeScript 5.0+, no `experimentalDecorators`). A legacy variant is also available
at `@caffeinejs/di/decorators/legacy` for projects that use
`experimentalDecorators: true` and `reflect-metadata`. The decorator API is
identical in both flavours; differences are noted inline where they exist.

- [@Injectable](#injectable)
- [@Lifetime](#lifetime)
- [@Named](#named)
- [@Primary](#primary)
- [@Fallback](#fallback)
- [@Lazy](#lazy)
- [@Profile](#profile)
- [@ConditionalOn](#conditionalon)
- [@Extends](#extends)
- [@Label](#label)
- [@Tag](#tag)
- [@Interceptor](#interceptor)
- [@BypassPostProcessors](#bypasspostprocessors)
- [@UseFactory](#usefactory)
- [@UseAsyncFactory](#useasyncfactory)
- [@PostConstruct](#postconstruct)
- [@OnDestroy](#ondestroy)
- [@Configuration](#configuration)
- [@Provides](#provides)
- [@Async](#async)
- [@PreDestroy](#predestroy)
- [@Inject](#inject)

---

## Decorators

### @Injectable

```ts
@Injectable()
@Injectable(key: NamedToken<T>)
@Injectable(deps: InjectionsFor<A>)
@Injectable(key: NamedToken<T>, deps: InjectionsFor<A>)
```

Marks a class as a container-managed bean and registers it in the global
decorator registry. The container will instantiate it, resolve its
dependencies, and manage its lifecycle.

**Parameters:**

- `key` — the binding key. Defaults to the class constructor reference.
- `deps` — explicit dependency list, one entry per constructor parameter, in
  order. Required when the class has constructor parameters. `$i.optional(X)`
  is only valid for a parameter typed `X | undefined` (or `x?: X`).

```ts
@Injectable()
class Cache {}

const kUserService = token<UserService>(Symbol.for('user-service'))

@Injectable(kUserService)
class UserService {}

@Injectable([Database, Logger])
class UserService {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}
}
```

**Legacy decorators:** With `@caffeinejs/di/decorators/legacy`,
constructor dependencies are inferred from TypeScript's `reflect-metadata` when
`emitDecoratorMetadata: true` is set, so `deps` is optional even when the class
has constructor parameters. Pass `deps` explicitly only to override the inferred
types, when using interface tokens, or when you need additional behaviour applied, like defining an injection as optional.

### @Lifetime

```ts
@Lifetime(scopeId: Identifier)
```

Sets the lifecycle scope for the binding. `Scopes.SINGLETON` is the default
when no `@Lifetime` is specified. Accepts any built-in or custom scope identifier.

```ts
@Injectable()
@Lifetime(Scopes.SINGLETON)   // one instance per container (explicit; same as default)
class CacheService { ... }

@Injectable()
@Lifetime(Scopes.TRANSIENT)   // new instance on every resolution
class RequestLogger { ... }

@Injectable()
@Lifetime(Scopes.REFRESH)     // singleton refreshed via container.refresher.refresh()
class RemoteConfig { ... }

@Injectable()
@Lifetime(Scopes.REQUEST)     // one instance per async context (Node.js only)
class RequestContext { ... }
```

### @Named

```ts
@Named(name: Identifier, ...names: Identifier[])
```

Registers additional string or symbol keys for this binding. The binding is
accessible under the class reference and all named keys.

```ts
@Injectable()
@Named('primary-db', Symbol.for('db'))
class PostgresDatabase { ... }
```

### @Primary

```ts
@Primary()
```

Marks this binding as preferred when multiple bindings exist for the same key.
`di.get()` returns this binding instead of throwing `ErrNoUniqueInjectionForKey`.

### @Fallback

```ts
@Fallback()
```

Marks this binding as a fallback. It is only used when no non-fallback binding
exists for the key.

### @Lazy

```ts
@Lazy()
```

Defers instantiation until first access instead of during `init()`.

### @Profile

```ts
@Profile(profile: Identifier, ...profiles: Identifier[])
```

Activates this binding only when one of the given profiles is active. The
container's active profiles are set via the `profiles` constructor option or
`addProfiles()`.

```ts
@Injectable()
@Profile('production')
class ProductionMailer implements Mailer { ... }

new CaffeineIoC({ profiles: ['production'] })
```

### @ConditionalOn

```ts
@ConditionalOn(condition: Conditional | Conditional[])
```

Activates this binding only when the predicate returns `true`. The predicate
receives a `ConditionContext`.

```ts
interface ConditionContext {
  container: { has(key: InjectionToken): boolean }
  key: InjectionToken
  binding: BindingDecoratorConfig
}
```

```ts
@Injectable()
@ConditionalOn(ctx => ctx.container.has(RedisClient))
class RedisCacheService implements CacheService { ... }
```

### @Extends

```ts
@Extends(base?: Ctor | AbstractCtor)
```

Registers this class under an abstract base class. When `base` is omitted, it
is inferred from the prototype chain.

```ts
abstract class Logger { abstract log(msg: string): void }

@Injectable()
@Extends(Logger)
class ConsoleLogger extends Logger { ... }

di.get(Logger) // ConsoleLogger
```

### @Label

```ts
@Label(label: symbol, ...labels: symbol[])
```

Attaches symbol labels to the binding for grouped retrieval via
`di.getBindingsByLabel(label)`.

```ts
const kHandler = Symbol.for('handler')

@Injectable()
@Label(kHandler)
class OrderHandler { ... }

@Injectable()
@Label(kHandler)
class PaymentHandler { ... }

di.getBindingsByLabel(kHandler) // [OrderHandler binding, PaymentHandler binding]
```

### @Tag

```ts
@Tag(key: symbol, value: unknown)
```

Attaches a symbol-keyed metadata value to the binding.

### @Interceptor

```ts
@Interceptor(fn: PostResolutionInterceptor<T>)
```

Wraps every resolved instance with `fn`. The interceptor receives a
`ResolutionContext` and the resolved instance, and must return the
(possibly wrapped) instance.

```ts
type PostResolutionInterceptor<T> = (ctx: ResolutionContext, instance: T) => T
```

### @BypassPostProcessors

```ts
@BypassPostProcessors()
```

Excludes this binding from all registered `PostProcessor` hooks.

### @UseFactory

```ts
@UseFactory(factory: Factory<T>)
```

Binds the class key to a synchronous factory function instead of the class
constructor.

```ts
type Factory<T> = (ctx: ResolutionContext) => T
```

### @UseAsyncFactory

```ts
@UseAsyncFactory(factory: AsyncFactory<T>)
```

Binds the class key to an async factory function. The container awaits the
result during `init()`.

```ts
type AsyncFactory<T> = (ctx: ResolutionContext) => Promise<T>
```

### @PostConstruct

```ts
@PostConstruct(fn?: (value: T) => void)
```

Registers a callback to run after the instance is created. When used without
arguments on a method, marks that method as the post-construct hook.

```ts
// On the class (callback form)
@Injectable()
@PostConstruct(instance => instance.connect())
class DatabasePool { ... }

// On a method
@Injectable()
class DatabasePool {
  @PostConstruct()
  connect() { ... }
}
```

### @OnDestroy

```ts
@OnDestroy(fn: (value: T) => void | Promise<void>)
```

Registers a callback to run before the instance is destroyed. Class-level
equivalent of `@PreDestroy`.

---

### @Configuration

```ts
@Configuration(deps?: Injection[])
```

Marks a class as a factory configuration. Its methods annotated with
`@Provides` are registered as individual bindings.

```ts
@Configuration([AppConfig])
class InfraConfig {
  constructor(private readonly config: AppConfig) {}

  @Provides(Database)
  database(): Database {
    return new PostgresDatabase(this.config.databaseUrl)
  }
}
```

**Legacy decorators:** With `@caffeinejs/di/decorators/legacy`,
`deps` is optional when `emitDecoratorMetadata: true` is enabled — constructor
parameter types are inferred from `reflect-metadata`.

### @Provides

```ts
@Provides(key: InjectionToken, deps?: Injection[])
```

Registers a method's return value as a binding for `key`. Must be used inside
a `@Configuration` class.

`deps` are resolved from the container and passed as method arguments.

Can be combined with `@Lifetime`, `@Named`, `@Primary`, `@Fallback`,
`@Lazy`, and `@Interceptor`.

### @Async

```ts
@Async()
```

Marks a `@Provides` method as returning a `Promise`. The container awaits the
result during `init()`.

```ts
@Configuration()
class RemoteConfig {
  @Provides(Config)
  @Async()
  async config(): Promise<Config> {
    return fetchFromVault()
  }
}
```

### @PreDestroy

```ts
@PreDestroy(fn?: (value: T) => void | Promise<void>)
```

Registers a pre-destroy callback for a `@Provides` binding. When used without
arguments on a method, marks that method as the pre-destroy hook.

---

### @Inject

```ts
@Inject(key: InjectionToken): ParameterDecorator & PropertyDecorator
@Inject(descriptor: InjectionDescriptor): ParameterDecorator & PropertyDecorator
@Inject(...deps: Injection[]): MethodDecorator
```

Injects a dependency into a constructor parameter, class property, or method.

**Constructor parameter:**

```ts
@Injectable()
class Service {
  constructor(@Inject('config') private readonly cfg: AppConfig) {}
}
```

**Property:**

```ts
@Injectable()
class Service {
  @Inject(Logger)
  private readonly logger!: Logger
}
```

**Method:**

```ts
@Injectable()
class Service {
  @Inject(Logger, Database)
  setup(logger: Logger, db: Database) { ... }
}
```
