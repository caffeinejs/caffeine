# `@caffeinejs/html`

Follow the root [`AGENTS.md`](../AGENTS.md). The rules below are specific to this package.

## What the package is

JSX server-side rendering on `@kitajs/html`. A handler returns `HTML(<Page />)`; the adapter answers with
the markup under `text/html; charset=utf-8`.

`@kitajs/html` has no render step: its `JSX.Element` is `string | Promise<string>`, so a JSX expression
_is_ the markup. That is why `HTMLNode` is `string | Promise<string>` and why this package's own sources
need no JSX compiler options — only its tests do.

`@kitajs/fastify-html-plugin` is a behavioural reference, not a dependency. Do not add it.

## Consumer tsconfig

An application authoring `.tsx` needs all three:

```jsonc
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@kitajs/html",
    "plugins": [{ "name": "@kitajs/ts-html-plugin" }],
  },
}
```

`@kitajs/ts-html-plugin` is the XSS scanner: `@kitajs/html` escapes nothing on its own, so without it an
unescaped `{userInput}` is reported nowhere. Its `xss-scan` bin is the CI equivalent.

It is an **optional** peer dependency, and that is load-bearing. Its own `typescript` peer is `^5.9.3`
against this repo's TypeScript 7; npm resolves a workspace package's peers, so a plain `peerDependencies`
entry fails `npm install` at the root with `ERESOLVE`. Marking it optional in `peerDependenciesMeta`
records the requirement for consumers while letting npm skip it here. Do not drop the `optional` flag, and
do not add it to `devDependencies`. It is a language-service plugin — it changes no emit and runs only in
an editor using the workspace TypeScript — so nothing in this package needs it present.

TypeScript 7's editor is LSP-based and does not load `tsconfig` `plugins`. Under the TypeScript 7 language
service, `@kitajs/ts-html-plugin` does not run; unescaped `{userInput}` is not reported in the editor.
Use the plugin's `xss-scan` CLI for that check, or keep the TypeScript 6 language service in the editor
until a TypeScript 7.1 API exists that the plugin can use.

## `autoDoctype` reaches a response through the config slice; Content-Type does not

`Context` carries no container, so `HTMLResult.respond` cannot resolve anything. `HTMLBuilder` registers its
slice under the `kHTMLConfig` feature key, and `respond` reads it with `ctx.config(kHTMLConfig)`. The key is
what makes that possible — where the settings live is the application's choice (`h.config(c => c.app.html)`,
or nowhere at all), and `HTML(...)` is called from application code that knows neither that location nor the
application's config type, so neither a path nor `C` is available to it.

When the application never installed `HTMLExt` no slice is registered, the key reads `undefined`, and
`HTML_DEFAULTS` applies — which is what keeps `HTML(...)` working with no setup.

There is no `HTMLExtension` and no Fastify decoration. Do not reintroduce either; the package registers no
Fastify plugin and does not appear in `printPlugins()`.

Content-Type has no app-level default and no per-call override — `HTMLOptions` carries no `contentType`
field. `respond` sets the hardcoded `text/html; charset=utf-8` only when the reply carries no Content-Type
yet; a route's `@Produces`, or a handler's own `ctx.header('content-type', ...)` call before returning
`HTML(...)`, both survive untouched. Those two are the only ways to get a different Content-Type — do not
add a `contentType` option back onto `HTML(...)`, and do not reintroduce an app-wide setting.

## `respond` returns, it does not send

`respond` returns the markup rather than calling `ctx.body(...)`, so the same result is correct on the
adapter and `http/error/error_handling.ts`. The adapter unwraps a `Responder` exactly once — never return
another `Responder` from `respond`.

## No route-level decorator

There is no `@HTML` decorator or `html()` route extension. `@Produces` already sets a route's
Content-Type. If one is ever added, `http/AGENTS.md` requires writing the `AnyRouteExtension` first and
having the decorator call it.

## Tests are `.tsx`

`_tests/*.test.tsx` so the real JSX authoring path is covered. That is why this package's `tsconfig.json`
sets `jsx`/`jsxImportSource` and includes `**/*.tsx`, and why `vitest.config.ts` sets `jsc.parser.tsx` and
the `react` transform. Only tests are
`.tsx`; `dist/` contains no JSX.
