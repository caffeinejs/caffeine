# Injection

- [Injection type](#injection-type)
- [InjectionDescriptor](#injectiondescriptor)
- [ResolveInjection and InjectedOf](#resolveinjection-and-injectedof)
- [Helpers](#helpers)
  - [allOf](#allof)
  - [optional](#optional)
  - [provide](#provide)
  - [mapped](#mapped)
  - [object](#object)
  - [defer](#defer)
  - [just](#just)
  - [compose](#compose)

Prefer the `$i` helpers over building an `InjectionDescriptor` manually — they are
more concise, composable, and less error-prone.

```ts
import { $i } from '@caffeinejs/di'

$i.allOf(Plugin)
$i.optional(Logger)
$i.provide(EmailSender)
```

---

## Injection type

```ts
type Injection<T = unknown> = InjectionToken<T> | InjectionDescriptor<T>
```

Every place that accepts a dependency specification accepts either a bare `InjectionToken`
or a full `InjectionDescriptor`. Helpers like `$i.optional()` and `$i.allOf()` return
`InjectionDescriptor` values that you pass in the same position.

Named keys use `token<T>(string | symbol)`. `T` is the resolved value type;
omitting it, or passing `any` or `unknown`, is a type error.

Constructor lists on `toClass`, `toSelf`, and `@Injectable` use `InjectionsFor<A>`:
one token or `$i` helper per parameter, in order. `$i.optional(X)` matches
`X | undefined`, not a required `X`.

```ts
@Injectable([Logger, $i.optional(Database), $i.allOf(Plugin)])
class App { ... }
```

---

## InjectionDescriptor

```ts
type InjectionDescriptor<T = unknown> = {
  key?: InjectionToken<any> // lookup token (independent of T when a helper wraps the result)
  multiple?: boolean // inject all bindings for the key
  optional?: boolean // ok if missing — injects undefined instead of throwing
  resolver?: symbol // custom resolver (overrides the default)
  args?: unknown // extra arguments passed to the resolver
}
```

`T` is the **resolved** value the consumer receives, not necessarily the lookup
key. `$i.optional(K)` encodes `U | undefined`, `$i.allOf(K)` encodes `U[]`,
`$i.provide(K)` encodes `Provider<U>`, and so on.

---

## ResolveInjection and InjectedOf

```ts
type ResolveInjection<I> = I extends InjectionToken<infer T>
  ? T
  : I extends InjectionDescriptor<infer T>
    ? T
    : never

type ObjectInjectionSpec = {
  [prop: string | symbol]: InjectionToken<any> | InjectionDescriptor<any> | ObjectInjectionSpec
}

type InjectedOf<S> = { [K in keyof S]: /* token → instance, descriptor → T, nested spec → recurse */ }
```

`InjectedOf<typeof spec>` turns an `$i.object` spec into the instance bag type.
A class is the token — do not wrap it in `token()`.

```ts
class UserService {}
class OrderService {}

const spec = {
  us: UserService,
  os: $i.optional(OrderService),
}

type Bag = InjectedOf<typeof spec>
// { us: UserService, os: OrderService | undefined }
```

---

## Helpers

### allOf

```ts
$i.allOf<K>(keyOrDescriptor: K): InjectionDescriptor<ResolveInjection<K>[]>
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

@Injectable([$i.allOf(Validator)])
class Pipeline {
  constructor(readonly validators: Validator[]) {}
}
```

### optional

```ts
$i.optional<K>(keyOrDescriptor: K): InjectionDescriptor<ResolveInjection<K> | undefined>
```

Marks a dependency as optional. If no binding is registered for the key, the
container injects `undefined` instead of throwing.

```ts
@Injectable([$i.optional(FeatureFlags)])
class UserService {
  constructor(private readonly flags?: FeatureFlags) {}
}
```

Can be combined with other helpers:

```ts
@Injectable([$i.optional($i.allOf(Plugin))])
```

### provide

```ts
$i.provide<K>(keyOrDescriptor: K): InjectionDescriptor<Provider<ResolveInjection<K>>>
```

Wraps the resolved dependency in a `Provider<T>`. The provider's `get()` method
resolves the dependency on each call, creating a fresh instance for transient
scopes. Use this to inject a shorter-lived dependency into a longer-lived one
without a scope violation.

```ts
interface Provider<T> {
  get(): T
}

@Injectable([$i.provide(TransientEmailSender)])
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
$i.mapped<K>(key: K): InjectionDescriptor<Map<string, ResolveInjection<K>>>
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

@Injectable([$i.mapped(kMovie)])
class MovieService {
  constructor(readonly movies: Map<string, Movie>) {}
  // movies.get('horror') → HorrorMovie instance
}
```

### object

```ts
$i.object<const S extends ObjectInjectionSpec>(spec: S): InjectionDescriptor<InjectedOf<S>>
```

Injects multiple dependencies into a single constructor parameter as an object.
The `spec` argument maps property names to injection keys or
descriptors. Use `InjectedOf<typeof spec>` when you want the bag type without
repeating it by hand.

```ts
const spec = { db: Database, logger: $i.optional(Logger) }

@Injectable([$i.object(spec)])
class UserService {
  constructor(readonly deps: InjectedOf<typeof spec>) {}
}
```

### defer

```ts
$i.defer<K>(keyFn: () => K): InjectionDescriptor<ResolveInjection<K>>
```

Defers key resolution until the container constructs the instance. Use this
when a circular module import would cause the key to be `undefined` at class
declaration time.

```ts
import { $i } from '@caffeinejs/di'

@Injectable([$i.defer(() => B)])
class A {
  constructor(private readonly b: B) {}
}

@Injectable([A])
class B {
  constructor(private readonly a: A) {}
}
```

### just

```ts
$i.just<T>(value: T): InjectionDescriptor<T>
```

Injects a constant value directly, without a container binding.

```ts
@Injectable([$i.just('localhost'), $i.just(5432)])
class DatabaseClient {
  constructor(
    readonly host: string,
    readonly port: number,
  ) {}
}
```

### compose

```ts
$i.compose(key: InjectionToken, ...fns: Array<(key: InjectionToken) => InjectionDescriptor>): InjectionDescriptor
```

Composes multiple injection modifier functions around a single key. Applies
each function's result to the descriptor from left to right.

```ts
const injectOptionalMany = (key: InjectionToken) => $i.compose(key, $i.optional, $i.allOf)
```
