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
| [`caching/`](caching/AGENTS.md)                                                     | `@caffeinejs/caching`                    |
| [`html/`](html/AGENTS.md)                                                           | `@caffeinejs/html`                       |
| [`kafka/`](kafka/AGENTS.md)                                                         | `@caffeinejs/kafka`                      |
| [`distlock/`](distlock/AGENTS.md)                                                   | `@caffeinejs/distlock`                   |
| [`resilience/`](resilience/AGENTS.md)                                               | `@caffeinejs/resilience`                 |
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

## After every edit

Run checks in this order and fix failures before considering the task complete. First match wins.

- **Docs-only** — every file edited in the task is `*.md`, and nothing else:
  1. `npm run lint:markdown` (or `make lint-markdown`)
- **Single workspace package** — code in one directory from root `package.json` `workspaces` (e.g. only `http/**`):
  1. `npm run build -w <pkg>`
  2. `npx tsc --build <pkg>/tsconfig.json` — the package's check project, and the only step here that type-checks `*.test.ts`
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

Every `X/tsconfig.build.json` carries the same `exclude`, and a new package copies it verbatim:

```json
[
  "dist",
  "node_modules",
  "**/_tests/**",
  "**/_testdata/**",
  "**/*.test.ts",
  "**/*.test-d.ts",
  "**/*.spec.ts",
  "**/*.testkit.ts",
  "**/*.e2e.ts",
  "vitest.config.ts"
]
```

Package-specific entries go after those, never instead of them. Excluding a test **helper** matters as much as
excluding a test: a helper under `_tests/` is not `*.test.ts`, so without `**/_tests/**` it is compiled into
the published `dist/`. The check project still sees all of it — `X/tsconfig.json` keeps `include: ["**/*.ts"]`,
so tests and helpers are type-checked and only emission stops. The same three patterns are excluded from
coverage in root [`vitest.config.ts`](vitest.config.ts) and [`codecov.yml`](codecov.yml), and from analysis in
[`sonar-project.properties`](sonar-project.properties); change them together.

Two solution files drive them: `npm run build` is `tsc --build tsconfig.build.json`, and
`npm run test:typecheck` is `tsc --build tsconfig.check.json`. Both are incremental; do not edit `dist/`
by hand.

A check project is the only thing that reads a test file. `tsconfig.build.json` excludes `**/*.test.ts`, so a
green `npm run build` says nothing about them, and Vitest type-checks only where a config turns it on —
`brewer/` and `testing/`, through their own `tsconfig.vitest.json`. `npm test` elsewhere runs tests it never
type-checked.

Every package in the table above is referenced by `tsconfig.check.json`, so the check project is its step 2.
`cli/` and `benchmarks/` are outside that solution and own a `test:typecheck` script the root chain calls
separately — they are the only two workspaces where `npm run test:typecheck -w <pkg>` means anything, so
`--if-present` against any other package silently does nothing. `devtools/ui` and `examples/**` are in neither:
nothing type-checks them.

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
export { kFeatureConfigure, type FeatureConfigureKit } from '@caffeinejs/std'

// correct
import { kFeatureConfigure, type FeatureConfigureKit } from '@caffeinejs/std'
import type { ThingConfig } from './config.js'
```

A package’s `index.ts` barrel aggregating that package’s **own** modules is not a passthrough and is fine.

## Where a feature puts what it produces

Where a value goes depends on who reads it, not on what is convenient:

| The value is…                                         | Goes to                                | Read with                               |
| ----------------------------------------------------- | -------------------------------------- | --------------------------------------- |
| a setting a user tunes from the environment or a file | the application's configuration tree   | the configure kit's `config`            |
| a value the feature runs on                           | an ordinary field on the builder       | the builder reads its own field         |
| a setting code outside the feature must read          | a container binding, in `configure`    | `container.getOptional(key)`            |
| something user code injects                           | a container binding, in `configure`    | `container.get` / constructor injection |
| one of many providers a single consumer collects      | a container binding with `.extends()`  | `container.getManyOptional(Base)`       |
| start-up wiring the server runs                       | the feature's `server` hook            | the adapter, in the feature's slot      |
| a plugin's own data                                   | the **closure** the plugin is built in | the captured value                      |

Those are the only answers, and there is no eighth. A value the application needs once everything is up is
either configuration — so the callback reads it out of the tree and hands it over — or an artifact, so it is a
binding. There is no side channel between a feature and the application's configuration: a feature registers
no slice, publishes no key, and adds no field to the resolved configuration object.

**A fluent method is the last word.** `s.drainDelay('5s')` is what the feature runs on; it is not a default that a
higher band quietly outranks. Configuration reaches a feature because the application's configure callback
wired it — `.shutdown((s, { config }) => s.config(config.app.shutdown))` — and by no other path. Where the more
specific of the two is named, the more specific wins: a setter beats the block `config(...)` handed over.

The server's own construction and listen settings are not a feature. `.server(configure, customize)` hands them
to the adapter — `configure` resolves them against the setup context, `customize` is handed the bare instance —
and the adapter builds the server from them in `setup()`, once the container has initialized.

Exceptions, where `config(...)` overlays what the fluent methods set:

- authentication scheme options, so a secret in the tree redirects one written in code
- kafka (`brokers`, `clientId`, `groupId`, and the rest of the configurable slice)
- messaging binding destinations (and the other keys a binding's config slice declares)

The application declares the whole schema, importing the feature's exported schema (`loggerConfigSchema`,
`cookieConfigSchema`, `healthConfigSchema`, …) rather than restating it. Importing it is what carries the feature's own defaults
into the tree, since the feature no longer seeds anything there — a block declared with required, undefaulted
fields and no source to fill them fails validation at `ready()`.

A feature nothing wired runs on its own defaults and its builder values alone: it works, and no file,
environment variable or argument reaches it.

Liveness is the author's choice rather than something the framework manufactures. A configuration node is live:
its fields follow every reload, so `b.config(config.app.thing)` follows a reload while
`b.port(config.app.thing.port)` reads a number once. A feature's own resolved options are a plain object read once, when the feature configures:
config loads before any feature configures, so there is nothing left to fold lazily — `configure` reads its
inputs, folds in whatever the builder itself holds (a dispatcher, a merged default), and binds the result. A
reload afterward does not reach an already-bound value. A feature that has to act on a change takes a view in its
`config(...)` instead: `(b, { store }) => b.config(store.view(t => t.app.thing))`.

Do not route a plugin's own configuration through a container key it reads back at server setup: the builder
is holding the value when it builds the plugin, so the plugin closes over it.
`instance.register(thingPlugin(options))` in the `server` hook is the whole act — there is no token to bind and
no registry entry to look up.

An HTTP feature's start-up wiring is its `server` hook, handed the server the application's adapter drives.
Under the Fastify adapter the hook body **is** a plugin body: the adapter registers it as one
`fastify-plugin`-wrapped plugin, so `instance` is the root server. Wrap a plugin the hook registers in
`fastify-plugin` and its hooks and decorations apply to the context it was registered in; leave it unwrapped and
they stay inside the plugin. The plugin does not choose that context: a feature or an application factory
registers it on the root server, a `router.plugin(...)` or a `@Use(...)` registers it inside that route group —
so one wrapped plugin covers every route or one group's routes, according to who asked for it.

Plugins register in the order they were written, which is the order of the application's `.with(...)` calls.
There are no stages and nothing is sorted by what a plugin is: a feature that must precede another is installed
first. The adapter installs one slot at a time, and a slot is finished — whatever its hook awaited, and whatever
it registered without awaiting — before the next one starts, so a feature that awaits before registering does
not move.

One framework slot leads that list, in `WebApplication.configurers()` and nowhere else: error handling, so
every route and hook the rest register is already covered by it. Everything else, this package's own features
included, follows in `.with(...)` order — the authentication gate included, which is why `.authentication(...)`
is written after the CORS plugin and before a hook that reads `req.user`. The default not-found handler is not a
feature: the adapter installs it after every plugin, and a plugin that set its own keeps it.

## Writing a feature

A feature is one interface with three members, all symbol-keyed so none of it shows on a fluent surface:

```ts
export interface Feature<C = unknown> {
  get [kFeatureName](): string
  [kFeatureConfigure](kit: FeatureConfigureKit<C>): void | Promise<void>
  [kFeatureBootstrap]?(kit: BootstrapKit<C>): void | Promise<void>
}
```

`[kFeatureName]` is the identity `.with` deduplicates on, so a feature accepting an instance name folds it
in (`kafka` vs `kafka:orders`) and one image cannot install the same instance twice. `[kFeatureConfigure]`
runs after configuration has resolved and before the container initializes, so the kit's `config` is readable
and binding is still open. `[kFeatureBootstrap]` is optional and runs after `container.init()`; look up bindings
there. Its kit carries the logger the application configured.

An HTTP feature that wires the server implements `HTTPFeature` from `@caffeinejs/http`, which adds a fourth
member: `[kFeatureServer]`, handed the server at the feature's install position, after the container has
initialized, together with the same `HTTPSetupContext` a plugin factory receives. It is a property rather than a
method, so a feature written for one server does not compile on an application running another.

That property is why the interface states the kit as `HTTPSetupContext`, with no `C`: a property's parameter is
checked strictly, so naming `C` there would make `HTTPFeature` invariant in it, and an application held without
its configuration type — `function portOf(app: WebApplication)` — could no longer take a configured one.
`HTTPFeatureBuilder` restores it, so a subclass's `server(instance, kit)` reads `HTTPSetupContext<C>`. That is
the same trade `configure` already makes, whose hook is a bivariant method while `FeatureBuilder.configure` is
handed `FeatureConfigureKit<C>`.

Most features extend `FeatureBuilder<C>` from `@caffeinejs/std`, which adds exactly one thing: it runs the
application's configure callbacks against the builder, with the resolved configuration, immediately before
`configure`. A subclass names itself, holds what its fluent methods set in ordinary fields, and binds in
`configure`.

The callback the application writes is `(builder, kit)` — one context argument, the same shape a plugin
factory takes. The kit is the `FeatureConfigureKit` the feature's own `configure` receives, so a callback
reads `config` and `store` and may `container.bind(...)`; it runs before `container.init()`, so there is no
`container.get(...)` yet. A plugin's builder callback is `HTTPPluginConfigurer` instead and is handed the
`HTTPSetupContext` its factory got, where the container resolves and binding is closed.

An HTTP feature extends `HTTPFeatureBuilder<C>` instead, and wires the server in `server`:

```ts
export class ThingBuilder<C = unknown> extends HTTPFeatureBuilder<C> {
  readonly [kFeatureName] = 'thing'

  #config: Partial<ThingConfig> | undefined
  #size: number | undefined

  config(config: Partial<ThingConfig>): this {
    this.#config = config
    return this
  }

  size(size: number): this {
    this.#size = size
    return this
  }

  protected configure(kit: FeatureConfigureKit<C>): void {
    kit.container.bind(kThingOptions, t => t.toValue(this.#size ?? this.#config?.size ?? DEFAULT_SIZE).internal())
  }

  protected async server(instance: FastifyInstance): Promise<void> {
    await instance.register(thingPlugin(this.#size ?? this.#config?.size ?? DEFAULT_SIZE))
  }
}
```

The package exports a **factory function**, generic over the application configuration type so the `config`
and `store` on the callback's kit are typed against the schema the application declared. An HTTP feature's
factory returns `HTTPFeature<C>`, not `Feature<C>`, or the server it is written against goes unchecked:

```ts
export function thing<C = unknown>(configure?: FeatureConfigurer<ThingBuilder<C>, C>): HTTPFeature<C> {
  return new ThingBuilder<C>(configure as never)
}
```

A feature taking an instance name overloads on it, and folds it into `[kFeatureName]`:

```ts
export function thing<C = unknown>(configure?: FeatureConfigurer<ThingBuilder<C>, C>): HTTPFeature<C>
export function thing<C = unknown>(instance: string, configure?: FeatureConfigurer<ThingBuilder<C>, C>): HTTPFeature<C>
```

The framework's own pre-registered builders — the shutdown policy, the logger, cookies, error handling — are
constructed before an application can name a callback, so `.shutdown(...)` and its siblings hand theirs over with
`builder[kAddConfigurer](configure)`. Nothing else uses that symbol.

A feature the application cannot configure implements `Feature` / `HTTPFeature` directly instead —
`FeatureBuilder` exists to run a configure callback, and one with no callback to run is not a feature builder.
There are two: `AuthorizationBuilder` and `GuardsBuilder`, which configure nothing tunable. Having real work in
both phases does not change this; having nothing to configure does. Being registered unconditionally does not
either — `ErrorHandlingBuilder` leads `WebApplication.configurers()` and is still a `FeatureBuilder`, because
`.errorHandling(...)` hands it a callback.

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

Do not restate the type, narrate the implementation, or TSDoc tests and obvious getters. Private `_` modules: do not document.

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
5. **Configuration keys** are spelled the way an environment variable folds: `clientId`, `callbackUrl`, `accessTtl`. `EnvConfigSource` turns `CLIENT_ID` into `clientId`, and only `CLIENT_I_D` would reach `clientID`. The TS identifier a key feeds still follows this file: the key `clientId` is applied with `clientID(...)`.

## Decorators

TC39 ECMAScript decorators only. Root `tsconfig.json` sets `"lib": ["Decorators", "esnext.decorators"]`. Never add `experimentalDecorators` or `emitDecoratorMetadata` to main-package tsconfigs. The NestJS benchmark configs use the legacy flags for comparison only — do not copy them.

## Git discipline

Never use `git stash`. If uncommitted changes exist and you need to switch state, stop and ask.

Never revert, discard, or `git checkout --` a file outside the current task’s scope — including files a tool (e.g. `oxlint --fix` / `oxfmt`) modified as a side effect. That uncommitted state is other in-progress work. Stop and report it; do not revert it yourself.
