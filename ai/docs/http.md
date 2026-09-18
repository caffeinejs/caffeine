# HTTP

Package: `@caffeinejs/http`. Adapter is Fastify.

```ts
import Fastify from 'fastify'
import { createWebApplication, fastifyAdapterFactory, Controller, Get, Post, Args, $p } from '@caffeinejs/http'

@Controller('/examples')
export class ExampleController {
  @Get('/')
  getAll() {
    return this.list.execute()
  }

  @Post('/')
  @Args([$p.body()])
  createOne(input: { name: string }) {
    return this.create.execute(input.name)
  }
}

const app = createWebApplication(fastifyAdapterFactory(Fastify({ logger: true })))
```

Side-effect-import the controller file from `main.ts` so `@Controller` registers.

- Routes: method decorators (`@Get`, `@Post`, …) on a `@Controller(path)` class. Constructor injection via `@Injectable` / the controller decorator’s dependency list.
- `@Args` / `$p` pick body, params, query — same idea as Kafka `$k`.
- `@Prefix` is a Fastify plugin prefix; `@Controller('/api/pets')` is the URL path, not a 404-scoped `/api` bubble.
- Errors: throw `ErrHTTPNotFound` (etc.). Render with `@Catch(ErrType)` on an `ErrorHandler` class, `{ global: false }` + `@CatchWith`, or a `@Catch` method on the controller. Duplicate global `@Catch` for the same class fails at boot. See [errors.md](errors.md).

## Programmatic routers

The second way to declare routes. Same compilation as a controller — same guards, authorization, validation, error
handling — with the configuration written as a chain instead of decorators.

```ts
import { $i } from '@caffeinejs/di'
import { $t } from '@caffeinejs/std'
import { Router } from '@caffeinejs/http'

const pets = new Router('/pets')
  .inject({ svc: PetService }) // every route of the group, and of groups nested in it
  .authorize({ schemes: ['Bearer'] })

pets
  .get('/:id') // opens the route; ctx.req.param() is { id: string }
  .inject($i => ({ audit: $i.optional(Audit) })) // or a plain spec, as the group above
  .schema({ params: $t.Object({ id: $t.Integer() }) }) // now { id: number }
  .handler((ctx, deps) => deps.svc.find(ctx.req.param().id))

pets.group('/:petID/orders', r =>
  r
    .post('/')
    .schema({ body: CreateOrder })
    .handler((ctx, deps) => deps.svc.order(ctx.req.body())),
)

app.mount(pets) // before app.ready()
```

- A verb takes `(path)`, `(path, handler)` or `(path, schema, handler)`. With a handler the route is closed there
  and then and the group comes back, so routes chain off one another either way:

  ```ts
  pets
    .get('/', (ctx, deps) => deps.svc.all())
    .get('/:id', { params: $t.Object({ id: $t.Integer() }) }, (ctx, deps) => deps.svc.find(ctx.req.param().id))
  ```

- An inline route is closed, so `.name()`, `.authorize()`, `.guards()`, `.with()` and `.inject()` are unreachable on
  it and its dependencies are the group's. A route needing any of those opens the chain and closes it with
  `.handler(fn)`.
- `.inject()` takes a spec or a function handed `$i`, on both `Router` and the route chain — so `optional`, `allOf`,
  `provide` and `value` are reachable without importing it. Both forms type `deps` identically.
- The handler takes the context first and the injected dependencies second — `undefined` when nothing was injected.
- `ctx.req.body()` is the parsed body. `ctx.req.param()` / `.query()` / `.header()` are typed from the schema, and
  path parameters are typed from the path when no schema declares them.
- `.group(path, fn)` nests; `.mount(...routers)` (or `.mount(path, ...routers)`) composes ones written elsewhere. A
  nested group starts from its parent's configuration and dependencies and may override them. The same router
  mounted twice into one host is added once.
- Route names default to method + path (`get_pets_id`) and are what the OpenAPI operationId is built from.
  `.name('find')` pins one.
- `.with(ext, ...)` applies extensions — how a package configures a route it does not own. http ships
  `bodyAsBuffer()`, `bodyAsStream()`, `fst(options)`, `compress(opts)` and `encoding(tokens)`; openapi ships
  `operation(detail)` and `apiGroup(detail)`. Each is the same implementation as its decorator.
- `.plugin(factory)` registers a Fastify plugin in front of that router's routes and the groups nested under
  it. Only a router bound to Fastify takes one, so it is created with `newRouter(path)` rather than
  `new Router(path)` —
  `newRouter('/pets').plugin(() => fp(instance => instance.register(fastifyCors, { origin: 'https://pets.example' }), { name: 'cors' }))`.
  A router from `new Router(path)` is bound to no adapter and mounts on any application.
  There is no `corsPlugin`/`compressPlugin` wrapper — register the third-party plugin directly, the same as any
  other Fastify plugin. The same on a controller is
  `@Use(factory)` above `@Controller`. A router takes only plugins, never features, and nothing is
  deduplicated: two groups wanting different settings pass two factories. The factory's context carries
  `config` as `ConfigHandle<unknown>` — a router does not know which application it will be mounted into.
- `fst({ ... })` is the Fastify escape hatch: lifecycle hooks, `attachValidation`, `logLevel`, custom compilers —
  everything Fastify takes except what the router already decides (`method`, `url`, `schema`, `config`, `handler`,
  `bodyLimit`, `handlerTimeout`).
- A router accumulates its routes in its type: `RoutesOf<typeof app>` is the whole surface, ready for a typed
  client. What carries them is the value `.handler()` returns, so a chain gathers them all.
- Writing routes as separate statements leaves one such value each. `blend(...routers)` unions them into one
  router — as do `.mount(...)` and `app.mount(...)`, which take several. The variable the routes were opened from
  carries none of them.

```ts
export const pets = new Router('/pets')
  .with(apiGroup({ name: 'Pets' }))
  .get('/')
  .handler(list)
  .get('/:id')
  .with(operation({ operationId: 'getPet' }))
  .handler(find)

type API = RoutesOf<typeof pets> // { method: 'GET', path: '/pets', ... } | { method: 'GET', path: '/pets/:id', ... }

// the same surface, written as statements
const owner = new Router('/pets')
const all = owner.get('/').handler(list)
const one = owner.get('/:id').handler(find)

export const petsRouter = blend(all, one)
```

## Typed client — `@caffeinejs/brewer`

The front-end half of the same types. No codegen, no schema file: the server's type _is_ the client's contract.

```ts
import { brewer } from '@caffeinejs/brewer'
import type { App } from './server/app.js' // export type App = typeof app

const client = brewer<App>('http://localhost:3000')

const res = await client.pets({ id: 1 }).get() // GET /pets/1
if (res.ok) {
  const pet = await res.json() // typed from the route's 200 schema
}

await client.pets.post({ body: { name: 'Rex' } })
```

- Static segments are properties; a parameterised segment is a call taking that one parameter. The path is never
  written out.
- A verb ends the chain. Returns a `Response` whose `.json()` is typed — checking `res.ok` is yours.
- `brewer<typeof app>`, `brewer<typeof someRouter>` and `brewer<RoutesOf<typeof app>>` all work, so a package can
  ship a client for just its own routes.
- Given the application instead of a URL, requests go through its own `fetch` and never reach a socket — which is
  how to test one. Both the routes and the transport come from the argument, so neither the type argument nor the
  URL is written. The application must be `ready()` first, or every call answers 404:

  ```ts
  await app.ready()
  const client = brewer(app)
  await client.pets({ id: 1 }).get()

  brewer<typeof petsRouter>(app) // one router's surface, driven through the application
  ```

  The target is structural — anything with a matching `fetch` works, a stub included — and `options.fetch` still
  wins over it.

- Zero runtime dependencies and browser-safe. The front-end needs `@caffeinejs/http` as a **devDependency** only to
  resolve the `App` type — `import type` is erased, so nothing ships.
- Escape hatch for a path built at run time, or a segment named after a verb:
  `client.$request('GET', '/pets/:id', { params: { id: 1 } })`.
- Static: `.with(staticFiles(s => s.serve(root, { prefix: '/static' })))`. That serves files. It is not SPA history fallback. Default `@fastify/static` `wildcard: true` will 404 missing files under the prefix, not return `index.html`.
