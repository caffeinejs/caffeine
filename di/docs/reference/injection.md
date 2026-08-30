# Injection

- [Injection type](#injection-type)
- [InjectionDescriptor](#injectiondescriptor)
- [Helpers](#helpers)
  - [allOf](#allof)
  - [optional](#optional)
  - [provide](#provide)
  - [mapped](#mapped)
  - [object](#object)
  - [defer](#defer)
  - [useValue](#usevalue)
  - [compose](#compose)

Prefer the helper functions over building an `InjectionDescriptor` manually — they are
more concise, composable, and less error-prone.

All helpers are exported individually or through the `inject` namespace:

```ts
// named imports
import { allOf, optional, provide, mapped, object, defer, useValue } from '@caffeinejs/di'

// namespace import — all helpers available as inject.*
import { inject } from '@caffeinejs/di'

inject.allOf(Plugin)
inject.optional(Logger)
inject.provide(EmailSender)
```

---

## Injection type

```ts
type Injection<T = unknown> = InjectionToken<T> | InjectionDescriptor<T>
```

Every place that accepts a dependency specification accepts either a bare `InjectionToken`
or a full `InjectionDescriptor`. Helpers like `optional()` and `allOf()` return
`InjectionDescriptor` values that you pass in the same position.

```ts
@Injectable([Logger, optional(Database), allOf(Plugin)])
class App { ... }
```

---

## InjectionDescriptor

```ts
type InjectionDescriptor<T = any> = {
  key?: InjectionToken<T>       // the dependency key
  multiple?: boolean // inject all bindings for the key (returns T[])
  optional?: boolean // ok if missing — injects undefined instead of throwing
  resolver?: symbol  // custom resolver (overrides the default)
  args?: unknown     // extra arguments passed to the resolver
}
```

---

## Helpers

### allOf

```ts
allOf(keyOrDescriptor: InjectionToken | InjectionDescriptor): InjectionDescriptor
```

Injects all bindings registered for a key as an array. This is the injection
equivalent of `di.getMany()`.

```ts
abstract class Validator {
  abstract validate(value: unknown): boolean
}

@Injectable()
class RequiredValidator extends Validator { ... }

@Injectable()
class MaxLengthValidator extends Validator { ... }

@Injectable([allOf(Validator)])
class Pipeline {
  constructor(readonly validators: Validator[]) {}
}
```

### optional

```ts
optional(keyOrDescriptor: InjectionToken | InjectionDescriptor): InjectionDescriptor
```

Marks a dependency as optional. If no binding is registered for the key, the
container injects `undefined` instead of throwing.

```ts
@Injectable([optional(FeatureFlags)])
class UserService {
  constructor(private readonly flags?: FeatureFlags) {}
}
```

Can be combined with other helpers:

```ts
@Injectable([optional(allOf(Plugin))])
```

### provide

```ts
provide(keyOrDescriptor: InjectionToken | InjectionDescriptor): InjectionDescriptor
```

Wraps the resolved dependency in a `Provider<T>`. The provider's `get()` method
resolves the dependency on each call, creating a fresh instance for transient
scopes. Use this to inject a shorter-lived dependency into a longer-lived one
without a scope violation.

```ts
interface Provider<T> {
  get(): T
}

@Injectable([provide(TransientEmailSender)])
@Lifetime(Scopes.SINGLETON)
class NotificationService {
  constructor(private readonly sender: Provider<TransientEmailSender>) {}

  send(msg: string) {
    this.sender.get().send(msg) // new instance each call
  }
}
```

### mapped

```ts
mapped(key: InjectionToken): InjectionDescriptor
```

Injects all bindings for `key` as a `Map<string, T>`, where the map key is
the binding's name. Useful when you need to look up bindings by name at
runtime.

```ts
const kMovie = token<Movie>('movie')

@Injectable(kMovie)
@Named('horror')
class HorrorMovie implements Movie { ... }

@Injectable(kMovie)
@Named('comedy')
class ComedyMovie implements Movie { ... }

@Injectable([mapped(kMovie)])
class MovieService {
  constructor(readonly movies: Map<string, Movie>) {}
  // movies.get('horror') → HorrorMovie instance
}
```

### object

```ts
object(spec: ObjectInjectionSpec): InjectionDescriptor
```

Injects multiple dependencies into a single constructor parameter as an object.
The `spec` argument maps property names to injection keys or
descriptors.

```ts
type ObjectInjectionSpec = {
  [prop: string | symbol]: InjectionToken | InjectionDescriptor | ObjectInjectionSpec
}
```

```ts
@Injectable([object({ db: Database, logger: optional(Logger) })])
class UserService {
  constructor(readonly deps: { db: Database; logger?: Logger }) {}
}
```

### defer

```ts
defer(keyFn: () => InjectionToken): InjectionDescriptor
```

Defers key resolution until the container constructs the instance. Use this
when a circular module import would cause the key to be `undefined` at class
declaration time.

```ts
import { defer } from '@caffeinejs/di'

@Injectable([defer(() => B)])
class A {
  constructor(private readonly b: B) {}
}

@Injectable([A])
class B {
  constructor(private readonly a: A) {}
}
```

### useValue

```ts
useValue<T>(value: T): InjectionDescriptor
```

Injects a constant value directly, without a container binding.

```ts
@Injectable([useValue('localhost'), useValue(5432)])
class DatabaseClient {
  constructor(readonly host: string, readonly port: number) {}
}
```

### compose

```ts
compose(key: InjectionToken, ...fns: Array<(key: InjectionToken) => InjectionDescriptor>): InjectionDescriptor
```

Composes multiple injection modifier functions around a single key. Applies
each function's result to the descriptor from left to right.

```ts
const injectOptionalMany = (key: InjectionToken) => compose(key, optional, allOf)
```
