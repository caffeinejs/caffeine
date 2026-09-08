# Contributor coding conventions

How to change **this** monorepo. Behavioral rules for agents live in [`AGENTS.md`](AGENTS.md). User-app and framework-usage agent files live in [`ai/`](ai/). Do not copy this file into application repos.

## Glossary

In this repository these names mean **this project**, not a third-party library:

| You say                                  | It means                                                           |
| ---------------------------------------- | ------------------------------------------------------------------ |
| Caffeine Framework, Caffeine, CaffeineJS | This monorepo (`caffeinejs/caffeine`). npm scope `@caffeinejs/*`.  |
| CaffeineIoC                              | `@caffeinejs/di` — the container. Brand spelling `IoC`, not `IOC`. |
| Caffeine HTTP, the HTTP package          | `@caffeinejs/http` (Fastify adapter).                              |

Package names (`@caffeinejs/kafka`, …) are the npm names. Workspace dirs are in the table below.

This is not NestJS, Express, or Spring Boot. Do not use `experimentalDecorators`, `emitDecoratorMetadata`, `reflect-metadata`, Nest `@Module` / `forRoot`.

When editing a first-party package, also read that package’s `AGENTS.md`:

| Directory                                                                           | Package                                  |
| ----------------------------------------------------------------------------------- | ---------------------------------------- |
| [`di/`](di/AGENTS.md)                                                               | `@caffeinejs/di`                         |
| [`http/`](http/AGENTS.md)                                                           | `@caffeinejs/http`                       |
| [`cors/`](cors/AGENTS.md)                                                           | `@caffeinejs/cors`                       |
| [`compress/`](compress/AGENTS.md)                                                   | `@caffeinejs/compress`                   |
| [`html/`](html/AGENTS.md)                                                           | `@caffeinejs/html`                       |
| [`kafka/`](kafka/AGENTS.md)                                                         | `@caffeinejs/kafka`                      |
| [`openapi/`](openapi/AGENTS.md)                                                     | `@caffeinejs/openapi`                    |
| [`messaging/`](messaging/AGENTS.md)                                                 | `@caffeinejs/messaging`                  |
| [`std/`](std/AGENTS.md)                                                             | `@caffeinejs/std`                        |
| [`static/`](static/AGENTS.md)                                                       | `@caffeinejs/static`                     |
| [`view/`](view/AGENTS.md)                                                           | `@caffeinejs/view`                       |
| [`multipart/`](multipart/AGENTS.md)                                                 | `@caffeinejs/multipart`                  |
| [`scan/`](scan/AGENTS.md)                                                           | `@caffeinejs/scan`                       |
| [`cli/`](cli/AGENTS.md)                                                             | `@caffeinejs/cli`                        |
| [`testing/`](testing/AGENTS.md)                                                     | `@caffeinejs/testing`                    |
| [`brewer/`](brewer/AGENTS.md)                                                       | `@caffeinejs/brewer`                     |
| [`devtools/`](devtools/AGENTS.md)                                                   | `@caffeinejs/devtools`                   |
| [`fetchy/fetchy/`](fetchy/fetchy/AGENTS.md)                                         | `@caffeinejs/fetchy`                     |
| [`fetchy/fetchy-undici/`](fetchy/fetchy-undici/AGENTS.md)                           | `@caffeinejs/fetchy-undici`              |
| [`fetchy/fetchy-logging-interceptor/`](fetchy/fetchy-logging-interceptor/AGENTS.md) | `@caffeinejs/fetchy-logging-interceptor` |
| [`plugins/eslint/`](plugins/eslint/AGENTS.md)                                       | `@caffeinejs/eslint-plugin`              |
| [`plugins/esbuild/`](plugins/esbuild/AGENTS.md)                                     | `@caffeinejs/esbuild-plugin`             |
| [`plugins/vite/`](plugins/vite/AGENTS.md)                                           | `@caffeinejs/vite-plugin`                |

Workspace membership is the root [`package.json`](package.json) `workspaces` list. Cross-package imports use the package name (`@caffeinejs/di`), not a relative path into another package.

Adding a workspace package that tests consume: [docs/internal/ci-build-artifacts.md](docs/internal/ci-build-artifacts.md).

## After every edit

Run checks in this order and fix failures before considering the task complete. First match wins.

- **Docs-only** — every file edited in the task is `*.md`, and nothing else:
  1. `npm run lint:markdown` (or `make lint-markdown`)
- **Single workspace package** — code in one directory from root `package.json` `workspaces` (e.g. only `http/**`):
  1. `npm run build -w <pkg>`
  2. `npm run test:typecheck -w <pkg> --if-present` (no-op when the package has no such script; vitest typecheck in `npm test` still covers test files)
  3. `npm test -w <pkg>`
  4. `npm run lint:fix -- <pkg-path>` — zero errors (warnings are pre-existing and acceptable)
- **Anything wider** — two or more workspace packages, or any non-md file outside every package directory (root `tsconfig*.json`, `.oxlintrc.json`, `.oxfmtrc.json`, root `package.json`, `vitest.config.ts`, `.github/**`):
  1. `npm run build`
  2. `npm run test:typecheck`
  3. `npm test`
  4. `npm run lint:fix`

Docs-only does not apply to TSDoc inside `.ts`, `ai/llms.txt`, YAML, JSON, or a mixed markdown-and-code diff. One non-md file means this is not docs-only.

When in doubt on **code** scope, run the full suite. A README next to a TypeScript change does not make the task docs-only.

Every package has two `tsc` projects. `X/tsconfig.build.json` emits `dist/` from the package sources and
references the sibling build projects it depends on. `X/tsconfig.json` type-checks the package _including_
its tests, emits nothing, and references only `./tsconfig.build.json`. Root `tsconfig.json` holds the shared
`compilerOptions` and nothing else.

Two solution files drive them: `npm run build` is `tsc --build tsconfig.build.json`, and
`npm run test:typecheck` is `tsc --build tsconfig.check.json`. Both are incremental; do not edit `dist/`
by hand.

Tests resolve `@caffeinejs/*` through package `exports` to `dist/*.d.ts` — the same resolution Vitest uses at
run time. There is no `source` export condition and no `paths` map, so a type-check needs the dependency
`dist/` to exist; `tsc --build` produces it. A check project is never referenced by another project, so it
cannot create a reference cycle.

The root `.npmrc` sets `ignore-scripts=true`. Never rely on npm `pre*` / `post*` / `postinstall` hooks; they will not fire. Explicit `npm run <name>` still runs.

## Import style

Group all imports from the same module into a single import statement. Enforced by `import/no-duplicates`.

```ts
// correct
import { Binder, BindTo } from './Binder.js'

// wrong
import { Binder } from './Binder.js'
import { BindTo } from './Binder.js'
```

All imports must include the `.js` extension, including TypeScript source files.

```ts
// correct
import { CaffeineIoC } from './container.js'

// wrong
import { CaffeineIoC } from './container'
```

Never use inline dynamic-import syntax as a type reference. Declare a top-level `import type` and use the name.

```ts
// correct
import type { Readable } from 'node:stream'
async upload(stream: Readable) { ... }

// wrong
async upload(stream: import('node:stream').Readable) { ... }
```

## Private modules

Files prefixed with `_` (e.g. `_noop.ts`) are private to their directory. Do not import them from a different directory. Enforced by `no-restricted-imports`.

```ts
// correct — same directory
import { noop } from './_noop.js'

// wrong
import { noop } from '../_noop.js'
```

## Re-exports

Do not re-export a symbol (type or value) from another module or package just to keep a surface stable or shorten an import path. Import from the source at every use site.

```ts
// wrong
export { kBootstrap, type FeatureLifecycle } from '@caffeinejs/std'

// correct
import { kBootstrap, type FeatureLifecycle } from '@caffeinejs/std'
import type { Services } from './service.js'
```

A package’s `index.ts` barrel aggregating that package’s **own** modules is not a passthrough and is fine.

## Where a feature puts what it produces

Where a value goes depends on who reads it, not on what is convenient:

| The value is…                                          | Goes to                                   | Read with                               |
| ------------------------------------------------------ | ----------------------------------------- | --------------------------------------- |
| a setting a user tunes from the environment or a file  | this feature's config slice               | `this.set(key, value)` → `this.slice`   |
| where that slice lives in the tree                     | the application's schema and selector     | `builder.config(c => c.app.thing)`      |
| a setting code outside the feature's builder must read | that slice, given a `configKey`           | `config(key)` on the config handle      |
| something user code injects                            | a container binding, in `bootstrap`       | `container.get` / constructor injection |
| one of many providers a single consumer collects       | a container binding with `.extends()`     | `container.getManyOptional(Base)`       |
| a start-up hook the platform runs                      | `kit.extensions.register(key, extension)` | `extensions.of(Base)`                   |
| an extension's own data                                | that extension's **constructor**          | the field                               |

Those are the only answers, and there is no eighth. A value the application needs once everything is up is
either configuration — so it goes in the slice, under a key — or an artifact, so it is a binding. There is no
side channel between a feature and the application, and no first-party bag a package reaches into: `http` used
to hand every extension a `Services` record assembled from four `Contributions` keys, and both are gone.

A feature never picks its own location in the configuration tree and never adds a field to the resolved
configuration object. The application declares the whole schema — importing the feature's exported schema
(`serverConfigSchema`, `healthConfigSchema`, …) rather than restating it — and names the location with the
builder's `.config(selector)`. A feature nothing pointed anywhere resolves **detached**, from its own defaults
and its builder values alone: it works, and no file, environment variable or argument reaches it.

Do not route an extension's own configuration through a container key it reads back at server setup: the
builder is holding the value when it constructs the extension. `kit.extensions.register(X, new X(data))` does
the binding and the registration together, because they are one act — `add(key)` alone binds nothing and
`bind(key)` alone registers nothing.

Extensions run in `kExtensionStage` order, then in the order their features were installed — which is the
order the application's `.extend(...)` calls are written. The install position is a property of the registry,
not of when a `bootstrap` hook reached the call, so a feature that awaits before registering does not move.

**`kExtensionStage` is framework-internal.** A package outside the framework sets nothing and lands in
`default`; `core` is wiring the rest builds on (the error handler, the body parsers, the routes the framework
serves itself) and `fallback` is what may only run once everything else has registered (the not-found
handler). It is symbol-keyed for the same reason `kFeatureName` is: it stays off the surface a feature is
authored against.

## Writing a feature builder

Extend `FeatureBuilder<T, C>` from `@caffeinejs/std`. It is a pure fluent authoring class — its methods return
`this` — and it **is** the `FeatureLifecycle`, with `[kFeatureName]`, `[kBeforeBootstrap]` and `[kBootstrap]`
symbol-keyed so none of it shows on the fluent surface. `.extend`'s `install` calls `ctx.addFeature(builder)`.

The base owns the whole configuration path: `.config(selector)`, the two bands, registering the slice and
publishing it under a key. A subclass declares `schema` (and optionally `configKey` and `defaults`), writes
into the band from its fluent methods with `set`, and does its binding in `bootstrap`:

```ts
export class ThingBuilder<C = unknown> extends FeatureBuilder<ThingConfig, C> {
  readonly [kFeatureName] = 'thing'

  protected readonly schema = thingConfigSchema
  protected readonly configKey = kThingConfig

  size(size: number): this {
    return this.set('size', size)
  }

  protected bootstrap(kit: BootstrapKit): Promise<void> {
    kit.extensions.register(ThingExtension, new ThingExtension(this.slice.config))
    return Promise.resolve()
  }
}
```

Three hooks cover what `set` cannot express. `configValues()` replaces the whole `CODE` band, for a builder
holding one options object its setters mutate. `beforeBootstrap()` runs once the slice exists and is where a
`derive(...)` goes — the fold from raw settings into the shape the feature runs on, plus whatever cannot
travel through a tree. `declared` reports whether the declare step ran at all, which is false only for a
builder driven directly rather than by an application.

A feature never picks its own location in the configuration tree. An option bag forwarded to a third-party
library is split with `splitOptionBag(...)`: the data half goes into the slice, the callbacks stay on the
builder and are merged back, because a function cannot travel through a configuration tree.

A builder that configures nothing tunable (`AuthorizationBuilder`, `GuardsBuilder`) implements
`FeatureLifecycle` directly instead — `FeatureBuilder` exists to own a slice, and one without a schema is not
a feature builder. So does a lifecycle that owns _several_ slices rather than one, as `view` does with its
per-engine builders.

## Error messages

- Sentence case; no trailing period; no contractions (`does not`, not `doesn't`)
- Active voice: `Cannot X` not `Unable to X` or `Failed to X`
- Colon for detail: `Cannot do X: reason`
- Double-quote user-supplied values: `"${keyStr(key)}"`
- Class prefix `Err`: `ErrNoResolutionForKey`, not `NoResolutionForKeyError`
- `.name` and `code` align: `ErrFoo` → `this.name = 'ErrFoo'`, `code = 'ERR_FOO'`
- Fixed, context-free solutions may call `solutions()` in the constructor. Contextual errors call `solutions()` at the throw site.

## Documentation

TSDoc is the **published contract** (`.d.ts` / hover), not git history. Write for the caller. Summary sentence first; details after a blank line. Do not document every export.

Write it when behavior surprises, sibling APIs look alike, callers must handle a specific `Err*` (`@throws`), a parameter’s meaning is not its name, or a generic/overload is non-obvious.

Do not restate the type, narrate the implementation, or TSDoc tests and obvious getters. Private `_` modules: a short `//` if a maintainer will get hurt, not a public block.

No design history in hover (“we rejected Nest”). Do document observable why when it **is** the contract (headers stay open because Ajv `removeAdditional` would strip `host`).

Do not analogize to Nest, Spring, ASP.NET, or Express in docs or TSDoc. Naming this package’s real peer (Fastify in `@caffeinejs/http`) is allowed when the reader must know it.

Tags: `{@link Symbol}`; `@param name -` only when the name is insufficient; `@throws`; `@example` only for call shapes types hide. Skip `@returns` unless the meaning is not the type. No `@class`, `@function`, or `@type`.

Voice: sentence case; complete sentences; same acronym rules as identifiers. No `NOTE:`, `IMPORTANT:`, or changelogs.

```ts
// correct — contract + why it surprises
/**
 * Compiles an authored schema to Fastify JSON Schema.
 *
 * `headers` stays open: Ajv `removeAdditional` would strip `host`.
 * @param context - Route id in failures, e.g. `POST /pets`
 */

// wrong — restates types / ADR / Nest
/** Takes a schema and returns FastifySchema like Nest ValidationPipe. */
```

## Acronym casing

One consistent case — never JS Title-case. Go convention: `URL`, `ID`, `OIDC`, `HTTP`, `JSON`.

- **PascalCase:** acronym uppercase — `HTTPClient`, `OIDCConfig`, `ErrOIDCCallback`
- **camelCase:** leading acronym fully lowercased; mid/trailing fully uppercased — `oidcConfig`, `clientID`, `parseJSON`, `authURL`
- `SCREAMING_SNAKE` already conforms — `ERR_OIDC_CALLBACK`

```ts
// correct
class HTTPClient {}
const oidcConfig = {}
function parseJSON(s: string) {}
const clientID = ''

// wrong
class HttpClient {}
const OidcConfig = {}
function parseJson(s: string) {}
const clientId = ''
```

Exceptions:

1. **`IoC`** stays stylized — `CaffeineIoC`, `IoC`. Not `IOC`.
2. **External / interop names** keep the upstream spelling: Node (`IncomingHttpHeaders`, `executionAsyncId`), WebCrypto (`JsonWebKey`), inspector/CDP (`CallFrameId`), fast-check (`fc.webUrl`), ESLint (`messageId`), JS built-ins (`toJSON`).
3. **Wire / protocol tokens** stay as the spec writes them (`HttpOnly`, `client_id`, `redirect_uri`). Surrounding TS identifiers still follow this file (`redirectURI`).
4. **A substring is not an acronym** — `Identity`, `Identifier`, `Candidate`, `Validate`, `Hidden`. Never rewrite them.

## Decorators

TC39 ECMAScript decorators only. Root `tsconfig.json` sets `"lib": ["Decorators", "esnext.decorators"]`. Never add `experimentalDecorators` or `emitDecoratorMetadata` to main-package tsconfigs. The NestJS benchmark configs use the legacy flags for comparison only — do not copy them.

## Git discipline

Never use `git stash`. If uncommitted changes exist and you need to switch state, stop and ask.

Never revert, discard, or `git checkout --` a file outside the current task’s scope — including files a tool (e.g. `oxlint --fix` / `oxfmt`) modified as a side effect. That uncommitted state is other in-progress work. Stop and report it; do not revert it yourself.
