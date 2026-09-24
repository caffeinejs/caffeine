# Single-page applications

`@caffeinejs/static` serves files. It has no SPA feature and no `.spa()` — a single-page application is
**routing the application writes**, so its prefix, its authorization and its ordering stay where the rest of
the application's routing is. Three exports are all it adds.

| Export                                         | For                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `sendFile(ctx, filename, root?, options?)`     | Sending a file from a handler, through `@fastify/static`'s own machinery |
| `download(ctx, filepath, filename?, options?)` | The same, as an attachment. A relative path needs `options.root`         |
| `isDocumentRequest(ctx, navigationOnly?)`      | Whether a request that matched no route should get the shell             |
| `spaMount(index?)`                             | The `@fastify/static` options a SPA's file mount always sets             |
| `immutableAssets(root, prefixes?)`             | A `setHeaders` callback pinning content-hashed assets                    |

## The two rules

**A path the application declared answers any client; a wildcard answers only a document request.** `/` and
`/index.html` are requests for the document itself, so a load balancer probe or `curl` gets the page.
`/settings` is a fallback, so it is a page for a browser and a 404 for anything else — which is what keeps a
missing `/assets/app-eZr2sdaR.js` a real 404 instead of HTML under a JavaScript content type.

**`return` what `sendFile` returns.** `@fastify/static` pumps the file without awaiting, so a handler that
drops the value lets the adapter send an empty body over it: the caller sees a 200 with nothing in it.

## Public application beside an API

```ts
import { resolve } from 'node:path'
import { ErrHTTPNotFound, newRouter, type Context } from '@caffeinejs/http'
import { immutableAssets, isDocumentRequest, sendFile, spaMount, staticFiles } from '@caffeinejs/static'

const DIST = resolve('site/dist')

const shellDocument = (ctx: Context) => sendFile(ctx, 'index.html', DIST)
const notFound = (ctx: Context): never => {
  throw new ErrHTTPNotFound(`Route ${ctx.req.method}:${ctx.req.url} not found`)
}
const clientRoute = (ctx: Context) => (isDocumentRequest(ctx) ? shellDocument(ctx) : notFound(ctx))

const pages = newRouter()
  .detail('http', { internal: true }) // @caffeinejs/openapi does not describe client routes
  .authorize({ allowAnonymous: true })
  .get('/', shellDocument)
  .get('/index.html', shellDocument)
  .get('/*', clientRoute)

// The API owns its own misses. **One line per API base, not per controller** — three controllers under
// `/api/*` share this one. Without it a browser navigating to `/api/typo` sees the application.
const apiMisses = newRouter('/api').get('/*', notFound)

app
  .with(
    staticFiles(s =>
      s.serve(DIST, { ...spaMount(), preCompressed: true, setHeaders: immutableAssets(DIST) }, { anonymous: true }),
    ),
  )
  .mount(apiMisses, pages)
```

`spaMount()` is
`{ wildcard: false, index: false, globIgnore: ['index.html', '**/*.br', '**/*.gz', '**/*.deflate'] }`.
`wildcard: false` is load-bearing, not a tuning knob: the default registers `GET <prefix>*`, which is the
application's own client-route path, and the two collide at start-up.

`preCompressed: true` needs no further setup. It finds `app-HASH.js.br` on the file system rather than through
the router, so the compressed siblings are served without being routes — which is why `spaMount()` ignores
them. It applies to `sendFile` too, so the shell served from a compiled route is compressed as well. Overriding
`globIgnore` **replaces** the list above rather than extending it, so restate whatever still applies.

`{ anonymous: true }` marks every file the mount registers exempt from authentication. Under
`requireAuthenticatedByDefault()` it is what keeps the public page's scripts loading — **forget it and the page
renders while every script answers 401**, which is loud in the browser and silent in the logs.

## Authentication, and protected client routes

**Use `addCookie`, not `addJWTBearer`.** A same-origin single-page application and its API want one scheme,
and the cookie scheme is it: its session cookie is an encrypted JWT, `HttpOnly` so no token sits in
JavaScript, and its challenge adapts to the caller — a browser navigation is redirected to `loginPath`, a
`fetch` gets 401 with the login URL in the body. The browser attaches the cookie to same-origin `fetch` on its
own, so the API needs no second credential. `addJWTBearer` reads `Authorization` only and never redirects, so
it cannot gate a page a browser navigates to; reach for it when the caller is cross-origin or a machine, and
register both with `forward(...)` if you need each.

One `authorize` per tier, on the application's own routers, over the same bundle:

```ts
const publicPages = newRouter()
  .authorize({ allowAnonymous: true })
  .get('/', shellDocument)
  .get('/login', shellDocument)
  .get('/*', clientRoute)

const memberPages = newRouter().authorize({}).get('/dashboard', shellDocument).get('/dashboard/*', clientRoute)

const adminPages = newRouter()
  .authorize({ roles: ['admin'] })
  .get('/admin', shellDocument)
  .get('/admin/*', clientRoute)
```

An anonymous navigation to `/dashboard` is redirected to the sign-in page _before the page loads_, an
anonymous `fetch` gets 401, and a signed-in member gets 403 on `/admin` — the ordinary gate, because these are
ordinary routes. Keep the sign-in page anonymous or the redirect loops.

The bundle stays public here: one bundle serves the public and the protected routes alike, and `/login` needs
it. The data is protected by the API.

**Two routes per gated subtree** — `/dashboard` and `/dashboard/*`. find-my-way does not match `/dashboard`
against `/dashboard/*`; the wildcard covers `/dashboard/` with an empty match, but not the bare path.

A prefixed router needs no special handling for the bare path: `newRouter('/app')` with a route at `/`
composes to `/app`, not `/app/`. So the pair is the ordinary one, written on the prefixed router —
`newRouter('/app').get('/', shellDocument).get('/*', clientRoute)`. Registering the routes on an unprefixed
router instead is a choice, not a workaround.

## A separate application whose bundle must be gated too

An administration build nobody else may even download. Its files are **not** mounted: `@fastify/static`'s file
routes are raw Fastify routes carrying no authorization, so they would fall to the application's fallback
policy. Serving them from a compiled route puts every byte behind the same `authorize` as the page.

```ts
const ADMIN = resolve('admin/dist')
const adminDocument = (ctx: Context) => sendFile(ctx, 'index.html', ADMIN)

const admin = newRouter()
  .detail('http', { internal: true })
  .authorize({ roles: ['admin'] })
  .get('/admin', adminDocument)
  .get('/admin/assets/*', ctx => sendFile(ctx, ctx.req.url.split('?', 1)[0]!.slice('/admin'.length), ADMIN))
  .get('/admin/*', ctx => (isDocumentRequest(ctx) ? adminDocument(ctx) : notFound(ctx)))

// `serve: false` registers no routes at all: the mount exists to decorate the reply and to name the root.
app.with(staticFiles(s => s.serve(ADMIN, { serve: false }))).mount(admin)
```

Path safety is `@fastify/static`'s: it rejects `..` and non-canonical paths before sending, and confines to
`root`.

Two applications on one origin are these two side by side. `/admin/*` beats `/*` by static-prefix length, so
nothing coordinates them.

## Under a base path

Behind a gateway forwarding `/app/...`, `.basePath('/app')` takes the base off before routing, so every route
above is written as it is, `ctx.req.url` included. What the browser loads is not: the shell's asset URLs come
from the build, so the bundler's own base (`base: '/app/'` in Vite) has to name it too. A redirect writes
`ctx.redirect('~/login')`, and a link or a form rendered by the server writes `ctx.req.basePath + '/login'`.
Cookie sign-in's `loginPath` and `accessDeniedPath` are written as the application sees them and get the base on
their own, and its session cookie is scoped to the base.

## Do not

- Return `index.html` from `@Catch(ErrHTTPNotFound)`. Client routes are routes; write them.
- Reach for `setNotFoundHandler`. The application's own stays its own.
- Read `Sec-Fetch-*` or `Accept` yourself — `isDocumentRequest` and the authentication schemes must agree, or
  a request is redirected to sign in by one and answered 404 by the other.
