# `@caffeinejs/html`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- `@kitajs/fastify-html-plugin` is a behavioural reference, not a dependency. Do not add it.
- `@kitajs/ts-html-plugin` stays an optional peer dependency (`peerDependenciesMeta`): its own `typescript` peer
  conflicts with this repository's TypeScript, so a plain `peerDependencies` entry fails root `npm install` with
  `ERESOLVE`. Do not drop the `optional` flag, and do not add it to `devDependencies`.
- `respond` reads `kHTMLOptions` off `ctx.platform.request.server`, never off the root instance, so a plugin
  registered inside one route group parameterizes that group's responses and no others.
- `HTMLOptions` carries no `contentType` field and there is no app-wide Content-Type setting. `respond` sets
  `text/html; charset=utf-8` only when the reply carries no Content-Type; a route's `@Produces` or a handler's
  `ctx.header('content-type', ...)` are the only overrides. Do not add either back.
- `respond` returns the markup; it does not call `ctx.body(...)`, so the same result is correct on the adapter and
  in `http/error/plugin.ts`. Never return another `Responder` from `respond`: the adapter unwraps exactly once.
- There is no `@HTML` decorator and no `html()` route extension; `@Produces` already sets a route's Content-Type.
  If one is ever added, write the `RouteExtension` first — see [`http/AGENTS.md`](../http/AGENTS.md).
