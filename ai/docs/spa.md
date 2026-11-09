# Single-page applications

`@caffeinejs/static` serves files. It has no SPA feature and no `.spa()` — a single-page application is
**routing the application writes**, so its prefix, its authorization and its ordering stay where the rest of
the application's routing is. Two exports are all it adds.

| Export                                    | For                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `sendFile(ctx, path, root?)`              | Sending a file a mount lists from a handler, as the mount's route would |
| `isDocumentRequest(ctx, navigationOnly?)` | Whether a request that matched no route should get the shell            |

A mount serves what `buildStatic()` from `@caffeinejs/static/build` listed in `static.manifest.json`, so the
front-end build ends with it:

```ts
import { buildStatic } from '@caffeinejs/static/build'

await buildStatic({ root: 'site/dist' }) // the .br and .gz variants, and the manifest
```

Start-up reads every file the manifest lists and checks its hash, so a file changed after the build fails the
deployment instead of going out under the tag of the bytes it replaced.

## The two rules

**A path the application declared answers any client; a wildcard answers only a document request.** `/` and
`/index.html` are requests for the document itself, so a load balancer probe or `curl` gets the page.
`/settings` is a fallback, so it is a page for a browser and a 404 for anything else — which is what keeps a
missing `/assets/app-eZr2sdaR.js` a real 404 instead of HTML under a JavaScript content type.

**`return` what `sendFile` returns.** It is a `Responder`, which answers in the handler's place only when the
handler returns it: a handler that drops the value answers with nothing in it.

## Public application beside an API

```ts
import { resolve } from 'node:path'

import { ErrHTTPNotFound, type IContext } from '@caffeinejs/http'
import { newRouter } from '@caffeinejs/http/fastify'
import { isDocumentRequest, sendFile, staticFiles } from '@caffeinejs/static'

const DIST = resolve('site/dist')

const shellDocument = (ctx: IContext) => sendFile(ctx, 'index.html', DIST)
const notFound = (ctx: IContext): never => {
  throw new ErrHTTPNotFound(`Route ${ctx.req.method}:${ctx.req.url} not found`)
}
const clientRoute = (ctx: IContext) => (isDocumentRequest(ctx) ? shellDocument(ctx) : notFound(ctx))

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
  .with(staticFiles(s => s.serve(DIST, { unrouted: ['index.html'], anonymous: true, immutable: ['assets/**'] })))
  .mount(apiMisses, pages)
```

`unrouted: ['index.html']` keeps the shell off the mount's routes, so `/` and `/index.html` are the
application's own routes above. The mount registers a route per file at its root and one per directory under
it: a miss under `/assets/` is the mount's own 404, and a miss at the root falls through to `/*`.

The `.br` and `.gz` variants the build wrote are negotiated by `Accept-Encoding` and are never URLs of their own.
They apply to `sendFile` too, so the shell served from a compiled route is compressed as well.

`immutable: ['assets/**']` pins the content-hashed files for a year (`immutableMaxAge` changes it); every other
file is revalidated on each use (`cacheControl`, default `'no-cache'`).

`{ anonymous: true }` marks every file the mount registers exempt from authentication, and lets a shared cache
store them (`Cache-Control: public`), since they are the same for every caller. Under
`requireAuthenticatedByDefault()` it is what keeps the public page's scripts loading — **forget it and the page
renders while every script answers 401**, which is loud in the browser and silent in the logs. `sendFile` always
writes `private`: it cannot see the gate of the route that called it.

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

const memberPages = newRouter().authorize().get('/dashboard', shellDocument).get('/dashboard/*', clientRoute)

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

An administration build nobody else may even download. Its files are **not** routed: a mount's file routes are
raw Fastify routes carrying no authorization, so they would fall to the application's fallback policy. Serving
them from a compiled route puts every byte behind the same `authorize` as the page.

```ts
const ADMIN = resolve('admin/dist')
const adminDocument = (ctx: IContext) => sendFile(ctx, 'index.html', ADMIN)

const admin = newRouter()
  .detail('http', { internal: true })
  .authorize({ roles: ['admin'] })
  .get('/admin', adminDocument)
  .get('/admin/assets/*', ctx => sendFile(ctx, ctx.req.url.split('?', 1)[0]!.slice('/admin'.length), ADMIN))
  .get('/admin/*', ctx => (isDocumentRequest(ctx) ? adminDocument(ctx) : notFound(ctx)))

// `unrouted: ['**']` registers no routes at all: the mount exists so `sendFile` can find its files.
app.with(staticFiles(s => s.serve(ADMIN, { unrouted: ['**'] }))).mount(admin)
```

Path safety is the manifest's: `sendFile` looks the path up among the files the build listed, decoding it first
when it starts with `/`, so `..`, a dotfile or anything the build did not list is a 404, and nothing joins a
request path onto `root`.

Two applications on one origin are these two side by side. `/admin/*` beats `/*` by static-prefix length, so
nothing coordinates them.

## Under a base path

Behind a gateway forwarding `/app/...`, `.basePath('/app')` takes the base off before routing, so every route
above is written as it is, `ctx.req.url` included. What the browser loads is not: the shell's asset URLs come
from the build, so the bundler's own base (`base: '/app/'` in Vite) has to name it too. A redirect writes
`ctx.redirect('~/login')`, and a link or a form rendered by the server writes `ctx.req.basePath + '/login'`.
Cookie sign-in's `loginPath` and `accessDeniedPath` are written as the application sees them and get the base on
their own, and its session cookie is scoped to the base.

## A download

`Attachment()` from `@caffeinejs/http` sends a file as an attachment, with its name and, given validators, ranges
and conditional requests:

```ts
import { openAsBlob } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { Attachment, ErrHTTPNotFound } from '@caffeinejs/http'

// Resolved once, so a symlink on the way to the directory itself does not fail every check.
const REPORTS = await realpath('var/reports')

const notFound = (): never => {
  throw new ErrHTTPNotFound()
}

/** Where `path` is under `REPORTS`, or undefined when it is outside, the directory itself or a dotfile. */
function confined(path: string): string | undefined {
  // On Windows, a path on another drive is relative to nothing, and comes back absolute.
  const inside = relative(REPORTS, path)
  const outside = inside === '' || isAbsolute(inside) || inside.split(sep).some(segment => segment.startsWith('.'))

  return outside ? undefined : inside
}

reports.get('/reports/*', async ctx => {
  // Confined twice: as written, then with symlinks resolved, since a link inside the directory can point anywhere.
  const requested = resolve(REPORTS, ctx.req.param('*') ?? '')
  confined(requested) ?? notFound()
  const real = await realpath(requested).catch(notFound)
  const name = confined(real) ?? notFound()
  const stats = await stat(real).catch(notFound)

  if (!stats.isFile()) {
    notFound()
  }

  // The checked path is the one opened, not the one requested.
  return Attachment(await openAsBlob(real), {
    name,
    etag: `"${stats.size}-${stats.mtime.getTime()}"`,
    lastModified: stats.mtime,
  })
})
```

This trusts whoever writes `var/reports`: a symlink swapped in between the check and the open is followed. Keep
the directory writable only by the application, or serve files a build lists instead.

A file the build lists is better served by a mount or `sendFile`, which never derive a path from a request.

## Do not

- Return `index.html` from `@Catch(ErrHTTPNotFound)`. Client routes are routes; write them.
- Reach for `setNotFoundHandler`. The application's own stays its own.
- Read `Sec-Fetch-*` or `Accept` yourself — `isDocumentRequest` and the authentication schemes must agree, or
  a request is redirected to sign in by one and answered 404 by the other.
