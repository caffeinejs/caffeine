# Getting Started

## Installation

```sh
npm install @caffeinejs/di
```

CaffeineIoC requires Node.js 20 or later and ships as an ES module with full CommonJS
support.

## Your first container

The core concept in CaffeineIoC is a **container**: an object that knows how to create
and wire up your application's dependencies. You tell the container what classes
exist and how to build them; the container handles construction and injection.

```ts
import { CaffeineIoC } from '@caffeinejs/di'
import { Extends, Injectable } from '@caffeinejs/di/decorators'

abstract class Logger {
  abstract log(msg: string): void
}

@Injectable()
@Extends()
class ConsoleLogger extends Logger {
  log(msg: string) {
    console.log(msg)
  }
}

@Injectable([Logger])
class UserService {
  constructor(private readonly logger: Logger) {}

  greet(name: string) {
    this.logger.log(`Hello, ${name}!`)
  }
}

const di = new CaffeineIoC()
await di.init()

const svc = di.get(UserService)
svc.greet('world') // Hello, world!
```

Three things happen here:

1. **Declare** — `@Injectable([Logger])` marks `UserService` as injectable and
   declares its dependencies. `@Extends()` on `ConsoleLogger` registers it as
   the implementation for `Logger`.
2. **Init** — `await di.init()` builds and validates the dependency graph.
3. **Get** — `di.get(UserService)` returns a fully-constructed instance with
   all dependencies injected.

:::info
`await di.init()` must be called before any resolving operation, like `di.get()`.
:::

## Scan and auto load decorated classes

Decorators are only evaluated if the file where the decorated class is implemented is loaded at least once.  
So this example would not work:

```ts
// file: product.repository.ts
import { Injectable } from '@caffeinejs/di/decorators'

@Injectable()
export class ProductRepository {}
```
```ts
// file: product.controller.ts
import { Injectable } from '@caffeinejs/di/decorators'

@Injectable([ProductRepository])
export class ProductController {
  constructor(private readonly repository: ProductRepository)
}
```
```ts
// file: app.container.ts
import { CaffeineIoC } from '@caffeinejs/di'

export function createContainer() {
  const container = new CaffeineIoC()
  return container
}
//
```

In this example, neither `ProductController`, nor `ProductRepository` were loaded by the time the container was created, so it does not know about them, and thus, they are not registered.  
We could solve this with:

```ts
import './product.controller.ts'
import { CaffeineIoC } from '@caffeinejs/di'

export function createContainer() {
  const container = new CaffeineIoC()
  return container
}
```

To avoid having to import all files with decorated classes, CaffeineIoC provides a `scan` feature that does the job automatically:

```ts
import { CaffeineIoC, scan } from '@caffeinejs/di'

// must be called before creating the container
await scan({
  dir: rootDir,
  exclude: [import.meta.url, new URL('./index.ts', import.meta.url)],
})

export function createContainer() {
  const container = new CaffeineIoC()
  return container
}
```

More about the `scan` at [Auto Load Decorated Classes](../guides/scanning-files).

## Named keys

Class references are the most common key type, but you can use strings and
symbols too. This is useful when binding a TypeScript interface — since
interfaces do not exist at runtime, a symbol acts as the token.

```ts
import { CaffeineIoC } from '@caffeinejs/di'
import { Injectable } from '@caffeinejs/di/decorators'

interface Logger {
  log(msg: string): void
}

const kLogger = Symbol.for('logger')

@Injectable(kLogger)
class ConsoleLogger implements Logger {
  log(msg: string) {
    console.log(msg)
  }
}

@Injectable([kLogger])
class UserService {
  constructor(private readonly logger: Logger) {}
}

const di = new CaffeineIoC()
await di.init()

const svc = di.get(UserService)
```

The same binding done manually with `bind()`:

```ts
const di = new CaffeineIoC()

di.bind(kLogger).toClass(ConsoleLogger)
di.bind(UserService).toClass(UserService, [kLogger])

await di.init()

const svc = di.get(UserService)
```

## Customizing injections

Injection keys alone are often not enough. CaffeineIoC ships a set of helper functions
that wrap a key into an `InjectionDescriptor`, letting you make a dependency
optional, inject all implementations at once, or defer resolution for circular
dependencies.

```ts
import { optional, allOf, provide, defer, useValue } from '@caffeinejs/di'
```

### optional

Marks a dependency as optional. If no binding is registered for the key the
container injects `undefined` instead of throwing.

```ts
@Injectable([optional(FeatureFlags)])
class UserService {
  constructor(private readonly flags?: FeatureFlags) {}
}
```

### allOf

Injects every binding registered for a key as an array. Use this with abstract
classes or named keys where multiple implementations are expected.

```ts
@Injectable([allOf(Validator)])
class Pipeline {
  constructor(readonly validators: Validator[]) {}
}
```

### provide

Wraps a dependency in a `Provider<T>` whose `get()` resolves a fresh instance
on each call. Use this when a longer-lived class needs a shorter-lived dependency
without a scope violation.

```ts
@Injectable([provide(TransientEmailSender)])
@Lifetime(Scopes.SINGLETON)
class NotificationService {
  constructor(private readonly sender: Provider<TransientEmailSender>) {}

  send(msg: string) {
    this.sender.get().send(msg)
  }
}
```

### defer

Defers key resolution until the container constructs the instance. Use this to
break circular module import cycles where the key would be `undefined` at class
declaration time.

```ts
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

Injects a constant value directly, with no container binding required.

```ts
@Injectable([useValue('localhost'), useValue(5432)])
class DatabaseClient {
  constructor(readonly host: string, readonly port: number) {}
}
```

### object

Injects multiple dependencies as a single plain-object parameter. The spec maps
property names to keys or descriptors.

```ts
@Injectable([object({ db: Database, logger: optional(Logger) })])
class UserService {
  constructor(readonly deps: { db: Database; logger?: Logger }) {}
}
```

### mapped

Injects all bindings for a key as a `Map<string, T>`, where each map key is the
binding's name. Useful when you need to look up an implementation by name at
runtime.

```ts
@Injectable()
@Named('horror')
class HorrorMovie implements Movie { ... }

@Injectable()
@Named('comedy')
class ComedyMovie implements Movie { ... }

@Injectable([mapped('movie')])
class MovieService {
  constructor(readonly movies: Map<string, Movie>) {}
  // movies.get('horror') → HorrorMovie instance
}
```

Helpers compose: `optional(allOf(Plugin))` injects all plugins or `undefined`
when none are registered. See [Injection](../reference/injection.md) for the
full reference.

## Manual binding

If you prefer not to use decorators, you can register bindings explicitly with
`bind()`. This is also useful for third-party classes you cannot decorate, or
when you need full control over how a binding is configured.

```ts
import { CaffeineIoC } from '@caffeinejs/di'

class Logger {
  log(msg: string) {
    console.log(msg)
  }
}

class UserService {
  constructor(private readonly logger: Logger) {}

  greet(name: string) {
    this.logger.log(`Hello, ${name}!`)
  }
}

const di = new CaffeineIoC()

di.bind(Logger).toSelf()
di.bind(UserService).toClass(UserService, [Logger])

await di.init()

const svc = di.get(UserService)
svc.greet('world') // Hello, world!
```

## Next steps

- [Modules](./modules.md) — composing bindings with module functions
- [Decorators](./decorators.md) — stage 3 and legacy decorator setup
- [Scopes](../reference/scopes.md) — controlling instance lifetime
- [Testing](./testing.md) — isolated containers for unit and integration tests
