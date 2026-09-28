# Testing

CaffeineIoC's `testing` sub-package provides `TestContainer`, a fluent builder designed
for **integration tests** — tests that exercise real components wired through the
real container. If you picture the test pyramid, `TestContainer` lives at the
integration layer and above: you boot an actual container, keep most bindings real,
and only replace components at the infrastructure boundary (databases, HTTP clients,
message queues, and other I/O).

```ts
import { TestContainer, newTestContainer } from '@caffeinejs/testing'
```

## Mental model

The production container is **never initialized directly** in tests. Instead:

1. **Build the production container** (`app.container.ts`) — register bindings, do not call `init()`.
2. **Feed it to `TestContainer`** — apply overrides, focus, and skip rules.
3. **Build the test container** — `.build()` returns a new, uninitialized container.
4. **Hand it to the application** — pass the test container where the app expects a container. The app initializes and disposes it through its own lifecycle hooks.

```ts
// app.container.ts — builds but never inits
export const appContainer = new CaffeineIoC({ modules: [databaseModule, emailModule] })

// test
const di = new TestContainer(appContainer).focus(OrderService).overrideWithMock(OrderRepository, fakeRepo).build() // uninitialized — app hooks do init() / dispose()

const app = buildApp(di) // app owns the container lifecycle from here
await app.ready()

const svc = di.get(OrderService)
```

The empty constructor skips step 1: `TestContainer` creates a container internally so a
test can import a single feature module instead of the whole application graph.

```ts
import { ordersModule } from './orders.gen.mod.js'

const di = new TestContainer().modules(ordersModule).overrideWithMock(OrderRepository, fakeRepo).build()
```

The container that comes out of `.build()` is a real CaffeineIoC container with all
production wiring intact, minus the pieces you replaced.

## What the rules reach

The test container holds what the source was told — its bindings made by hand, its
modules, its profiles and its decorated classes — and registers all of it itself when
it initializes. `.override()`, `.focus()`, `.isolate()`, `.skip()` and
`.skipAsyncBindings()` run after that, once every binding is registered and its
profiles and conditions are decided. So they reach a binding however it was made:
decorated, bound by hand, bound by one of the source's modules, or bound by a module
passed to `.modules()`.

The rules are applied when the test container initializes, not when `.build()`
returns. Whatever they leave has to resolve: a binding that depends on a skipped or
pruned one fails `init()` unless it is skipped or replaced too.

## Source: container, snapshot, or empty

`TestContainer` accepts an uninitialized container, a `Snapshot`, or no argument:

```ts
// from the uninitialized production container
const di = new TestContainer(appContainer).build()

// from a snapshot — what the container was told, frozen when it was taken
const snap = appContainer.snapshot()
const di = new TestContainer(snap).build()

// from scratch — no application graph; import a feature module instead
const di = new TestContainer().modules(ordersModule).overrideWithMock(OrderRepository, fakeRepo).build()
```

Passing the container takes its snapshot. A snapshot records what the container was
told: its bindings made by hand, its modules, its profiles and whether it registers
decorated classes. It does not record what the container registered — the test
container runs the modules and registers the decorated classes itself — so it saves
no setup work. Take one explicitly when the source will change after you build from
it.

Either way, the test container keeps the values the source bound with
`bindConfig()`, so `$i.config` injections resolve as they do in production.

When constructed empty, the test container registers decorated classes, so types
imported via the feature module register on it.

## Replacing a binding

`.override()` substitutes any binding — decorated, bound by hand or bound by a module —
while leaving the rest of the tree intact:

```ts
const di = new TestContainer(appContainer).override(EmailClient, b => b.toClass(InMemoryEmailClient)).build()
```

`.overrideWithMock()` is the shorthand for replacing with a mock or ready-made value.
The mock argument is typed loosely enough that a vitest mock or a duck-typed fake
does not need a double assertion:

```ts
const di = new TestContainer(appContainer).overrideWithMock(EmailClient, noOpEmailClient).build()
```

Overrides are always exempt from `.skipAsyncBindings()` filters — an overridden
key is never removed by that filter even if the original binding was async.

## Replacing the values

The values `$i.config` reads are not a binding, so `.override()` does not reach them.
Bind the test's own values on the container `.build()` returns. It is not initialized
yet, and a second `bindConfig()` call replaces the values the source carried:

```ts
const di = new TestContainer(appContainer).build()
di.bindConfig<AppConfig>({ database: { host: 'localhost', port: 5432 } })
await di.init()
```

## Narrowing the container

`.focus()` restricts the container to only the bindings reachable from the given
root keys. Every binding not in that dependency tree is dropped.

```ts
// test only OrderService and the components it pulls in
const di = new TestContainer(appContainer).focus(OrderService).build()
```

Multiple roots accumulate — the container keeps the union of all their trees:

```ts
const di = new TestContainer(appContainer).focus(OrderService).focus(InvoiceService).build()
```

`.focus()` dramatically reduces init time in large applications: instead of
initializing hundreds of beans, only the slice relevant to the test is booted.

## Isolating a dependency tree

`.isolate()` combines an override with dependency pruning. When you replace a
binding and also want to drop its original dependencies from the container, use
`isolate()` instead of `override()`:

```ts
// replace Database and prune only its exclusive deps (not shared with others)
const di = new TestContainer(appContainer).isolate(Database, false, b => b.toValue(inMemoryDb)).build()

// replace Database and prune ALL its transitive deps, shared or not
const di = new TestContainer(appContainer).isolate(Database, true, b => b.toValue(inMemoryDb)).build()
```

Pass `false` to preserve bindings that other parts of the tree also depend on.
Pass `true` to force-prune everything reachable from the replaced key.

`.isolateWithMock()` is the shorthand:

```ts
const di = new TestContainer(appContainer).isolateWithMock(Database, true, inMemoryDb).build()
```

## Removing bindings

`.skip()` drops one or more bindings entirely. Useful for components that have no
meaningful role in a particular test (analytics, telemetry, background jobs):

```ts
const di = new TestContainer(appContainer).skip(Analytics, MetricsReporter).build()
```

A binding that depends on a skipped one must be skipped or replaced too, or
`init()` fails.

## Dropping async bindings

Async bindings (created with `@UseAsyncFactory` or `@ProvidesAsync`) hold network or I/O
connections and often have real latency. `.skipAsyncBindings()` removes all of
them, so the container boots instantly in environments where those connections are
not needed.

```ts
// drop all async bindings
const di = new TestContainer(appContainer).skipAsyncBindings().build()

// drop all async except the in-memory message bus you still need
const di = new TestContainer(appContainer).skipAsyncBindings(MessageBus).build()
```

Bindings registered through `.override()` or `.isolate()` are always kept,
regardless of this filter.

## Activating profiles

The test container activates the source's profiles. `.profiles()` replaces them: only
the profiles it names are active, so a `@Profile('test')` class the source left out
is registered, and one only the source's profiles matched is not.

```ts
const di = new TestContainer(appContainer).profiles('test', 'no-cache').build()

await di.init()
```

## Adding test modules

Pass extra modules to inject test-specific bindings that do not exist in the
production container. They run after the source's modules, and the rules reach what
they bind: a `.focus()`ed container drops a test binding nothing in the focused
graph depends on.

```ts
const di = new TestContainer(appContainer).modules(testHelpersModule).build()

await di.init()
```

For a feature-focused test, start from an empty `TestContainer` and pass only the
generated feature module:

```ts
import { ordersModule } from './orders.gen.mod.js'

const di = new TestContainer().modules(ordersModule).overrideWithMock(OrderRepository, fakeRepo).build()
```

## Lazy loading

`TestContainer` is lazy by default — bindings are not instantiated until first
access. This keeps each test fast: only the beans the test actually touches are
booted.

Turn it off when a test depends on eager side-effects (e.g. event listeners
registered inside a constructor):

```ts
const di = new TestContainer(appContainer).lazy(false).build()

await di.init()
```

## Full example

The pattern below tests HTTP routes end-to-end through a Fastify app.
`app.container.ts` builds but never initializes the container. `app.ts` receives
the container, registers `onReady`/`onClose` hooks that call `di.init()` and
`di.dispose()`, then returns a Fastify instance. Tests build a test variant of the
container and hand it to `buildApp()` — the app's lifecycle hooks take care of
init and dispose.

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { TestContainer } from '@caffeinejs/testing'
import { appContainer } from '../app.container.js'
import { buildApp } from '../app.js'

describe('POST /orders', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    const save = vi.fn().mockResolvedValue({ id: 'ord-1', item: 'book', qty: 2 })
    const findById = vi.fn()

    const di = new TestContainer(appContainer)
      .focus(OrderService)
      .overrideWithMock(OrderRepository, { save, findById })
      .skipAsyncBindings()
      .build()

    app = buildApp(di) // app calls di.init() in onReady, di.dispose() in onClose
    await app.ready()
  })

  afterAll(async () => {
    await app.close() // triggers onClose → di.dispose(); no manual dispose needed
  })

  it('creates an order and returns 201', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { item: 'book', qty: 2 },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ id: 'ord-1' })
  })

  it('calls repository.save with the submitted payload', async () => {
    const di = app.diContainer // however the app exposes the container
    const repo = di.get(OrderRepository)

    await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { item: 'book', qty: 2 },
    })

    expect(repo.save).toHaveBeenCalledWith({ item: 'book', qty: 2 })
    expect(repo.save).toHaveBeenCalledTimes(1)
  })

  it('returns 400 when qty is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orders',
      payload: { item: 'book' },
    })

    expect(res.statusCode).toBe(400)
  })
})
```

`OrderService` and the route handler run with real production wiring. Only
`OrderRepository` is replaced — with a plain object whose methods are `vi.fn()`
spies — so assertions can cover both the HTTP surface and the exact calls made
into the data layer.

## Best practices

### Project Structure

To ensure that the core components of your application are "testable",
we recommend following the structure below, organizing the basic application components into three files with distinct responsibilities:

```
src/
  index.ts          ← entry point: wires everything and starts the server. Minimum logic here.
  app.container.ts  ← builds the CaffeineIoC container (no init())
  app.ts            ← builds the server, receives a container
```

:::note
The filenames and structure are incidental. What matters is that the container is a parameter — passed into the application rather than created inside it — so tests can substitute it before the application starts.
:::

**`app.container.ts`** — creates and exports the production container. Never calls
`init()` here; initialization is the caller's responsibility.

```ts
// app.container.ts
import { CaffeineIoC } from '@caffeinejs/di'

export function createContainer() {
  const container = new CaffeineIoC()
  // registrations ...
  return container
}
```

**`app.ts`** — builds the application instance, for example an HTTP server, that receives the container as a parameter.  
We recommend hooking the container lifecycle into the server lifecycle.  
Or, delegate these to the entry point. It is a matter of preference.  
See the example below with [Fastify](https://fastify.dev/):

```ts
// app.ts
import Fastify from 'fastify'
import type { Container } from '@caffeinejs/di'

export function buildApp(container: Container) {
  const app = Fastify()

  app.addHook('onReady', async () => {
    await container.init()
  })

  app.addHook('onClose', async () => {
    await container.dispose()
  })

  // register routes, plugins, etc.
  // the container or specific dependencies can be passed down to these components.

  return app
}
```

**`index.ts`** — the process entry point. Imports both, passes the container to
the app, and starts listening.

```ts
// index.ts
import { appContainer } from './app.container.js'
import { buildApp } from './app.js'

const app = buildApp(appContainer)
await app.listen({ port: 3000 })
```

With this structure, `index.ts` is never imported in tests. Tests import
`app.container.ts` and `app.ts` independently.

### Init and dispose in tests

When `buildApp()` hooks `di.init()` into `onReady` and `di.dispose()` into
`onClose`, tests need only `await app.ready()` and `await app.close()`:

```ts
beforeAll(async () => {
  app = buildApp(di)
  await app.ready() // triggers onReady → di.init()
})

afterAll(async () => {
  await app.close() // triggers onClose → di.dispose()
})
```

If the container is initialized outside `buildApp()` — for instance, in the entry point — tests must call `di.init()` explicitly before resolving instances, and `di.dispose()` when the test suite finishes.

```ts
beforeAll(async () => {
  app = buildApp(di)
  await di.init()
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await di.dispose()
})
```
