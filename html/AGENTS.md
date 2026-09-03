# `@caffeinejs/html`

Follow the root [`AGENTS.md`](../AGENTS.md). The rules below are specific to this package.

## What the package is

JSX server-side rendering on `@kitajs/html`. A handler returns `HTML(<Page />)`; the adapter answers with
the markup under `text/html; charset=utf-8`.

`@kitajs/html` has no render step: its `JSX.Element` is `string | Promise<string>`, so a JSX expression
*is* the markup. That is why `HTMLNode` is `string | Promise<string>` and why this package's own sources
need no JSX compiler options — only its tests do.

`@kitajs/fastify-html-plugin` is a behavioural reference, not a dependency. Do not add it.

## Consumer tsconfig

An application authoring `.tsx` needs all three:

```jsonc
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@kitajs/html",
    "plugins": [{ "name": "@kitajs/ts-html-plugin" }]
  }
}
```

`@kitajs/ts-html-plugin` is the XSS scanner: `@kitajs/html` escapes nothing on its own, so without it an
unescaped `{userInput}` is reported nowhere. Its `xss-scan` bin is the CI equivalent.

It is an **optional** peer dependency, and that is load-bearing. Its own `typescript` peer is `^5.9.3`
against this repo's `^6.0.3`; npm resolves a workspace package's peers, so a plain `peerDependencies`
entry fails `npm install` at the root with `ERESOLVE`. Marking it optional in `peerDependenciesMeta`
records the requirement for consumers while letting npm skip it here. Do not drop the `optional` flag, and
do not add it to `devDependencies`. It is a language-service plugin — it changes no emit and runs only in
an editor using the workspace TypeScript — so nothing in this package needs it present.

## `autoDoctype` reaches a response through Fastify; Content-Type does not

`Context` carries no container, so `HTMLResult.respond` cannot resolve anything. `HTMLExtension` decorates
the Fastify instance under the `kHTMLDefaults` symbol and `respond` reads `autoDoctype` back through
`(ctx as FastifyContext).fst` — the escape hatch `http/context.ts` documents. When the application never
installed `HTMLExt` there is no decoration and `HTML_DEFAULTS` applies, which is what keeps `HTML(...)`
working with no setup. Do not route this through a config slice or a container key.

Content-Type has no app-level default and no per-call override — `HTMLOptions` carries no `contentType`
field. `respond` sets the hardcoded `text/html; charset=utf-8` only when the reply carries no Content-Type
yet; a route's `@Produces`, or a handler's own `ctx.header('content-type', ...)` call before returning
`HTML(...)`, both survive untouched. Those two are the only ways to get a different Content-Type — do not
add a `contentType` option back onto `HTML(...)`, and do not reintroduce an app-wide setting.

## `respond` returns, it does not send

`respond` returns the markup rather than calling `ctx.body(...)`, so the same result is correct on all
three dispatch sites: the adapter, `http/error/error_handling.ts`, and `http/middleware/pipeline.ts`. The
adapter unwraps a `Responder` exactly once — never return another `Responder` from `respond`.

## No route-level decorator

There is no `@HTML` decorator or `html()` route extension. `@Produces` already sets a route's
Content-Type. If one is ever added, `http/AGENTS.md` requires writing the `AnyRouteExtension` first and
having the decorator call it.

## Tests are `.tsx`

`_tests/*.test.tsx` so the real JSX authoring path is covered. That is why this package's `tsconfig.json`
sets `jsx`/`jsxImportSource` and includes `**/*.tsx`, and why `vitest.config.ts` sets `jsc.parser.tsx` and
the `react` transform. Only tests are
`.tsx`; `dist/` contains no JSX.
