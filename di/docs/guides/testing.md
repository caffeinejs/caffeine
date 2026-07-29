# Testing

CaffeineIoC's `testing` sub-package provides `TestContainer`, a fluent builder designed
for **integration tests** — tests that exercise real components wired through the
real container. If you picture the test pyramid, `TestContainer` lives at the
integration layer and above: you boot an actual container, keep most bindings real,
and only replace components at the infrastructure boundary (databases, HTTP clients,
message queues, and other I/O).

```ts
import { TestContainer, newTestContainer } from '@caffeinejs/di/testing'
```

## Mental model

The production container is **never initialized directly** in tests. Instead:

1. **Build the production container** (`app.container.ts`) — register bindings, do not call `init()`.
2. **Feed it to `TestContainer`** — apply overrides, focus, and skip rules.
3. **Build the test container** — `.build()` returns a new, uninitialized container.
4. **Hand it to the application** — pass the test container where the app expects a container. The app initializes and disposes it through its own lifecycle hooks.

```ts
// app.container.ts — builds but never inits
export const appContainer = new CaffeineIoC(databaseModule, emailModule)

// test
const di = new TestContainer(appContainer)
  .focus(OrderService)
  .overrideWithValue(OrderRepository, fakeRepo)
  .build()                    // uninitialized — app hooks do init() / dispose()

const app = buildApp(di)      // app owns the container lifecycle from here
await app.ready()

const svc = di.get(OrderService)
```

The container that comes out of `.build()` is a real CaffeineIoC container with all
production wiring intact, minus the pieces you replaced.

## Source: container or snapshot

`TestContainer` accepts an uninitialized container or a `Snapshot`:

```ts
// from the uninitialized production container
const di = new TestContainer(appContainer).build()

// from a snapshot — avoids re-reading decorator registrations on every test
const snap = appContainer.snapshot()
const di = new TestContainer(snap).build()
```

When the production container is cheap to construct, passing it directly is fine.
When decorator scanning or module setup is expensive, snapshot it once and reuse
across test suites.

## Replacing a binding

`.override()` substitutes any binding while leaving the rest of the tree intact:

```ts
const di = new TestContainer(appContainer)
  .override(EmailClient, b => b.toClass(InMemoryEmailClient))
  .build()
```

`.overrideWithValue()` is the shorthand for replacing with a ready-made value:

```ts
const di = new TestContainer(appContainer)
  .overrideWithValue(EmailClient, noOpEmailClient)
  .build()
```

Overrides are always exempt from `.skipAsyncBindings()` filters — an overridden
key is never removed by that filter even if the original binding was async.

## Narrowing the container

`.focus()` restricts the container to only the bindings reachable from the given
root keys. Every binding not in that dependency tree is dropped.

```ts
// test only OrderService and the components it pulls in
const di = new TestContainer(appContainer)
  .focus(OrderService)
  .build()
```

Multiple roots accumulate — the container keeps the union of all their trees:

```ts
const di = new TestContainer(appContainer)
  .focus(OrderService)
  .focus(InvoiceService)
  .build()
```

`.focus()` dramatically reduces init time in large applications: instead of
initializing hundreds of beans, only the slice relevant to the test is booted.

## Isolating a dependency tree

`.isolate()` combines an override with dependency pruning. When you replace a
binding and also want to drop its original dependencies from the container, use
`isolate()` instead of `override()`:

```ts
// replace Database and prune only its exclusive deps (not shared with others)
const di = new TestContainer(appContainer)
  .isolate(Database, false, b => b.toValue(inMemoryDb))
  .build()

// replace Database and prune ALL its transitive deps, shared or not
const di = new TestContainer(appContainer)
  .isolate(Database, true, b => b.toValue(inMemoryDb))
  .build()
```

Pass `false` to preserve bindings that other parts of the tree also depend on.
Pass `true` to force-prune everything reachable from the replaced key.

`.isolateWithValue()` is the shorthand:

```ts
const di = new TestContainer(appContainer)
  .isolateWithValue(Database, true, inMemoryDb)
  .build()
```

## Removing bindings

`.skip()` drops one or more bindings entirely. Useful for components that have no
meaningful role in a particular test (analytics, telemetry, background jobs):

```ts
const di = new TestContainer(appContainer)
  .skip(Analytics, MetricsReporter)
  .build()
```

## Dropping async bindings

Async bindings (created with `@UseAsyncFactory` or `@Async`) hold network or I/O
connections and often have real latency. `.skipAsyncBindings()` removes all of
them, so the container boots instantly in environments where those connections are
not needed.

```ts
// drop all async bindings
const di = new TestContainer(appContainer)
  .skipAsyncBindings()
  .build()

// drop all async except the in-memory message bus you still need
const di = new TestContainer(appContainer)
  .skipAsyncBindings(MessageBus)
  .build()
```

Bindings registered through `.override()` or `.isolate()` are always kept,
regardless of this filter.

## Activating profiles

```ts
const di = new TestContainer(appContainer)
  .profiles('test', 'no-cache')
  .build()

await di.init()
```

## Adding test modules

Pass extra modules to inject test-specific bindings that do not exist in the
production container:

```ts
const di = new TestContainer(appContainer)
  .modules(testHelpersModule)
  .build()

await di.init()
```

## Lazy loading

`TestContainer` is lazy by default — bindings are not instantiated until first
access. This keeps each test fast: only the beans the test actually touches are
booted.

Turn it off when a test depends on eager side-effects (e.g. event listeners
registered inside a constructor):

```ts
const di = new TestContainer(appContainer)
  .lazy(false)
  .build()

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
import { TestContainer } from '@caffeinejs/di/testing'
import { appContainer } from '../app.container.js'
import { buildApp } from '../app.js'

describe('POST /orders', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    const save = vi.fn().mockResolvedValue({ id: 'ord-1', item: 'book', qty: 2 })
    const findById = vi.fn()

    const di = new TestContainer(appContainer)
      .focus(OrderService)
      .override(OrderRepository, b => b.toValue({ save, findById }))
      .skipAsyncBindings()
      .build()

    app = buildApp(di)    // app calls di.init() in onReady, di.dispose() in onClose
    await app.ready()
  })

  afterAll(async () => {
    await app.close()     // triggers onClose → di.dispose(); no manual dispose needed
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
    const di = app.diContainer           // however the app exposes the container
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
  await app.ready()   // triggers onReady → di.init()
})

afterAll(async () => {
  await app.close()   // triggers onClose → di.dispose()
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
