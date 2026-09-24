# HTTP

Package: `@caffeinejs/http`. Adapter is Fastify.

```ts
import { createWebApplication, Controller, Get, Post, Args, $p } from '@caffeinejs/http'

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

const app = createWebApplication().server(({ config }) => ({ listener: config.server }))

await app.run() // or app.run({ port: 3000 })
```

The adapter builds the Fastify instance itself; `.server(configure)` is how it is configured — `factory` for
Fastify's constructor options, `listener` for `listen()`. `.serverCallback(callback)` gets the setup context and the
bare instance before anything registers.

Side-effect-import the controller file from `main.ts` so `@Controller` registers.

- Routes: method decorators (`@Get`, `@Post`, …) on a `@Controller(path)` class. Constructor injection via `@Injectable` / the controller decorator’s dependency list.
- `@Args` / `$p` pick body, params, query — same idea as Kafka `$k`.
- `@Prefix` is a Fastify plugin prefix; `@Controller('/api/pets')` is the URL path, not a 404-scoped `/api` bubble.
- Errors: throw `ErrHTTPNotFound` (etc.). Render with `@Catch(ErrType)` on an `ErrorHandler` class, then enrol it with `.errorHandling(e => e.globalHandlers(H))`; or leave it unenrolled and name it with `@CatchWith`, or use a `@Catch` method on the controller. Enrolling two handlers for the same class fails at boot. See [errors.md](errors.md).

## HTTPS and HTTP/2

TLS and HTTP/2 are `factory` options, so configuration can switch them at `ready()`:

```ts
createWebApplication({ config })
  .server(({ config }) => ({
    factory: { https: { key: config.tls.key, cert: config.tls.cert } },
    listener: config.server,
  }))
```

- `https: { key, cert, ... }` serves TLS over HTTP/1.1.
- `http2: true` with `https` serves HTTP/2 over TLS. Add `allowHTTP1: true` to the TLS options to also answer
  HTTP/1.1 clients. Without `https`, `http2: true` is cleartext HTTP/2 (h2c), which browsers do not speak.
- `app.address.origin` starts with `https://` when the server serves TLS.

`app.instance` is a `FastifyInstance` whichever server was built. Narrow to reach what only the TLS server has:
`if (app.instance.server instanceof https.Server) app.instance.server.setSecureContext({ key, cert })` rotates a
certificate without a restart. Under HTTP/2, `ctx.req.raw` and `ctx.platform.reply.raw` are Node's
`Http2ServerRequest` and `Http2ServerResponse`, typed as their HTTP/1 counterparts. Narrow them with `instanceof`
for `stream`.

Two things differ under HTTP/2:

- HTTP/2 has no connection-specific headers. Node refuses or drops `Connection`, `Keep-Alive`,
  `Transfer-Encoding` and `Upgrade`, so do not set them with `@Header(...)` or `ctx.header(...)`.
- The host is in the `:authority` pseudo-header, not `host`. A custom constraint strategy has to read both.

## Serving under a base path

Behind a gateway or proxy that forwards `/api/...` with the prefix intact, `.basePath('/api')` serves the whole
application under it — or `.basePath(({ config }) => config.app.basePath)`, resolved at `ready()`. Under Watt:
`.basePath(() => getBasePath({ throwOnMissing: false }))`.

The server takes the base off a request's path before routing, so nothing the application declares changes:
routes from every source, plugin routes such as the health probes and static files, `app.use(path, …)` and
fallback-policy exceptions are all written as if served from the root. A request without the base is routed as it
came, so the base is not an access boundary: every route also answers without it, and keeping a route private is
the gateway's job or authorization's.

- `ctx.req.url` is the path the application sees; `ctx.req.basePath` is what was taken off (`''` when nothing was),
  so the base follows the request: a request that came without it is answered without it.
- Redirects the framework builds carry the base: cookie sign-in's `loginPath` / `accessDeniedPath` and the return
  URL, OAuth/OIDC's return URL and `defaultRedirectPath`, a `@caffeinejs/static` mount's `redirect` and `list`
  links, and the directory redirect of `sendFile` / `download`. A handler's own redirect says so with `~/`:
  `ctx.redirect('~/done')` is `/api/done`, while `ctx.redirect('/done')` is sent as written.
  `AuthenticationProperties.redirectURI` and the `returnTo` query of an OAuth/OIDC `loginPath` take `~/` too. A
  link in a page writes `ctx.req.basePath + '/done'`.
- The cookie scheme scopes its session and remember-me cookies to the base (`Path=/api`), so applications sharing
  an origin under different bases keep their sessions apart. The scope follows the request: a sign-in that came
  without the base writes them at `/`. `.path('/')` shares one session with requests that come without the base.
  Its `loginPath` and `accessDeniedPath` are written as the application sees them — `/login`, never `~/login`,
  which is refused.
- OAuth/OIDC `callbackURL` and `loginPath` are the URLs the browser sees, so they include the base. Their cookies
  stay at `Path=/` — `__Host-` cookies must — so applications sharing an origin give them distinct
  `sessionCookieName(...)` / `stateCookieName(...)`.
- `@caffeinejs/openapi` names the base as the document's server when the application named none, and links the
  docs page under it. A typed client takes the base in its URL: `brewer<App>('https://gateway.example/api')`.

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
  `newRouter('/pets').plugin(() => [fastifyCors, { origin: 'https://pets.example' }])`.
  A router from `new Router(path)` is bound to no adapter and mounts on any application.
  There is no `corsPlugin`/`compressPlugin` wrapper — register the third-party plugin directly, the same as any
  other Fastify plugin. A factory returns the plugin, or the plugin paired with the options to register it
  with; an official plugin already wraps itself in `fastify-plugin`, so a wrapper written only to carry its
  options would be encapsulated and reach no routes. The same on a controller is
  `@Use(factory)` above `@Controller`. A router takes only plugins, never features, and nothing is
  deduplicated: two groups wanting different settings pass two factories. The factory's context carries
  `config` as `LiveConfig<unknown>` — a router does not know which application it will be mounted into.
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

## Authorization declarations

`@Authorize` / `@Roles` / `@AllowAnonymous` and the routers' `.authorize({ ... })` are one mechanism, and
declarations **add up**: none replaces another, on one route or across the levels above it.

- One `roles` list is satisfied by **any** of its roles; separate declarations are **each** required.
  `@Roles('admin', 'manager')` is "admin or manager"; `@Roles('admin')` next to `@Roles('manager')`, or on the
  controller and on the method, is "both". Every policy named, at any level, has to pass.
- A router nested in another adds to what its parent declared. It can never widen it.
- A bare `@Authorize()` asks for the default policy (an authenticated caller) and keeps applying when a more
  specific level names a policy of its own. Naming only `schemes` is bare too: schemes pick who authenticates.
- `@AllowAnonymous` / `{ allowAnonymous: true }` opens what declares nothing below it. The most specific
  declaration wins: a method with `@Authorize` inside a public controller is protected, and a method with
  `@AllowAnonymous` inside a protected controller is public.
- `authz.requireAuthenticatedByDefault()` (or `fallbackPolicy(...)`) gates every route that declares nothing —
  the ones a plugin registered straight on Fastify included. Open under it: a route declared public, the health
  probes, OAuth callbacks, a URL no route matches (404), the prefixes in `{ except: ['/assets/'] }`, and a plain
  Fastify route registered with `config: authenticationExempt()`.
- A route naming several `schemes` advertises every one of them on a 401. A custom handler adds its challenge with
  `ctx.appendHeader('WWW-Authenticate', ...)`, not `ctx.header(...)`, which would replace the others'.
- A policy must hold at least one requirement. `addPolicy('x', p => {})` fails at start-up
  (`ERR_AUTHZ_POLICY_EMPTY`): it would be satisfied by every caller, anonymous included.
- A policy only asks what it says. `p.assert(...)` alone admits an anonymous caller that satisfies it; add
  `p.requireAuthenticated()` when an identity is part of the rule.

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
- The routes are the ones the application declares. An application served under a `.basePath(...)` puts the base
  in the URL — `brewer<App>('https://gateway.example/api')` — which the path is joined onto, never resolved
  against.
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
- Static: `.with(staticFiles(s => s.serve(root, { prefix: '/static' })))`. That serves files. It is not SPA history fallback — for a single-page application see [spa.md](spa.md), which is routing the application writes. Default `@fastify/static` `wildcard: true` will 404 missing files under the prefix, not return `index.html`.
