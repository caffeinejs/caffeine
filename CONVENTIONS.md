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
| [`bff/`](bff/AGENTS.md)                                                             | `@caffeinejs/bff`                        |
| [`devtools/`](devtools/AGENTS.md)                                                   | `@caffeinejs/devtools`                   |
| [`integrations/typeorm/`](integrations/typeorm/AGENTS.md)                           | `@caffeinejs/typeorm`                    |
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
  4. `make lint:<pkg-path>` — zero errors (warnings are pre-existing and acceptable). Not `npm run lint:fix -- <pkg-path>`: npm appends the path only to `oxfmt`, so oxlint would run on the whole repo.
- **Anything wider** — two or more workspace packages, or any non-md file outside every package directory (root `tsconfig*.json`, `.oxlintrc.json`, `.oxfmtrc.json`, root `package.json`, `vitest.config.ts`, `.github/**`):
  1. `npm run build`
  2. `npm run test:typecheck`
  3. `npm test`
  4. `npm run lint:fix`
  5. `make check` before asking for review — it also lints markdown, builds the CLI binary and the examples, and runs `test:memory`, which is what CI runs.

Docs-only does not apply to TSDoc inside `.ts`, `ai/llms.txt`, YAML, JSON, or a mixed markdown-and-code diff. One non-md file means this is not docs-only.

When in doubt on **code** scope, run the full suite. A README next to a TypeScript change does not make the task docs-only.

- `npm run build` does not produce the CLI binary. After a clone or a clean, run `npm run build:cli` (or `make build:cli`) before any example test or `caffeine generate`, or `node_modules/.bin/caffeine` is missing.
- A new production dependency must carry a license in the allowlist in `tools/check-licenses.mjs`; the `license-check` workflow fails the pull request otherwise.

### Build and check projects

- Every package has two `tsc` projects. `X/tsconfig.build.json` emits `dist/` from the package sources and references the sibling build projects it depends on. `X/tsconfig.json` type-checks the package including its tests, emits nothing, and references only `./tsconfig.build.json`. Root `tsconfig.json` holds the shared `compilerOptions` and nothing else.
- Every `X/tsconfig.build.json` carries the same `exclude`, and a new package copies it verbatim. Package-specific entries go after those, never instead of them:

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

- A test helper under `_tests/` is not `*.test.ts`; without `**/_tests/**` it is compiled into the published `dist/`. The check project still sees it, because `X/tsconfig.json` keeps `include: ["**/*.ts"]`.
- The same patterns are excluded from coverage in root [`vitest.config.ts`](vitest.config.ts) and [`codecov.yml`](codecov.yml), and from analysis in [`sonar-project.properties`](sonar-project.properties). Change them together.
- `npm run build` is `tsc --build tsconfig.build.json`; `npm run test:typecheck` is `tsc --build tsconfig.check.json`. Both are incremental. Never edit `dist/` by hand.
- A green `npm run build` says nothing about tests: only a check project reads a test file. Vitest type-checks only where a config turns it on (`brewer/` and `testing/`, through their own `tsconfig.vitest.json`); `npm test` elsewhere runs tests it never type-checked.
- `cli/` and `benchmarks/` are outside `tsconfig.check.json` and own a `test:typecheck` script; they are the only workspaces where `npm run test:typecheck -w <pkg>` does anything. `devtools/ui` and `examples/**` are type-checked by nothing.
- Tests resolve `@caffeinejs/*` through package `exports` to `dist/*.d.ts`. There is no `source` condition and no `paths` map, so a type-check needs the dependency `dist/` to exist: build first.
- The root `.npmrc` sets `ignore-scripts=true`. Never rely on npm `pre*` / `post*` / `postinstall` hooks; they will not fire. Explicit `npm run <name>` still runs.

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
| a plugin's setting read per request                   | a Fastify decoration the plugin sets   | `request.server[kThing]`                |

Those are the only answers.

- No side channel between a feature and the configuration: a feature registers no slice, publishes no key, and adds no field to the resolved configuration object. A value the application needs once everything is up is either configuration, read out of the tree by the callback, or a binding.
- A fluent method is the last word: `s.drainDelay('5s')` is what the feature runs on. Configuration reaches a feature only because the application's configure callback handed it over (`.shutdown((s, { config }) => s.config(config.app.shutdown))`). The more specific wins: a setter beats the block `config(...)` handed over.
- Exceptions, where `config(...)` overlays what the fluent methods set: authentication scheme options (a secret in the tree redirects one written in code); kafka (`brokers`, `clientId`, `groupId`, and the rest of the configurable slice); messaging binding destinations (and the other keys a binding's config slice declares).
- The application declares the whole schema by importing the feature's exported schema (`loggerConfigSchema`, `cookieConfigSchema`, `healthConfigSchema`, …), never by restating it. Importing it carries the feature's defaults into the tree; a block with required, undefaulted fields and no source fails validation at `bootstrap()`.
- A feature nothing wired runs on its own defaults and its builder values alone.
- A configuration node is live and a resolved options object is read once: `b.config(config.app.thing)` follows a reload, `b.port(config.app.thing.port)` reads a number once, and a bound value is not reached by a later reload. A feature that must act on a change takes a view instead: `(b, { store }) => b.config(store.view(t => t.app.thing))`.
- A plugin closes over its own options. Do not route them through a container key it reads back at server setup; `instance.register(thingPlugin(options))` in the `server` hook is the whole act.
- The server's construction and listen settings are not a feature: `.server(configure)` hands them to the adapter, which builds the server in `setup()` once the container has initialized.
- Under the Fastify adapter a feature's `server` hook body is a plugin body; the adapter registers it as one `fastify-plugin`-wrapped plugin, so `instance` is the root server. A plugin the hook registers reaches its parent context only when wrapped in `fastify-plugin`; unwrapped, its hooks and decorations stay inside it.
- Plugins install in the order of the application's `.with(...)` calls. There are no stages and nothing is sorted by kind; a feature that must precede another is installed first. One slot finishes, including what its hook awaited and what it registered without awaiting, before the next starts.
- One framework slot leads, in `WebApplication.configurers()` and nowhere else: error handling. The default not-found handler is not a feature; the adapter installs it after every plugin, and a plugin that set its own keeps it.

## Writing a feature

A feature is one interface with three members, all symbol-keyed so none of it shows on a fluent surface:

```ts
export interface Feature<C = unknown> {
  get [kFeatureName](): string
  [kFeatureConfigure](kit: FeatureConfigureKit<C>): void | Promise<void>
  [kFeatureBootstrap]?(kit: BootstrapKit<C>): void | Promise<void>
}
```

- `[kFeatureName]` is the identity `.with` deduplicates on. A feature accepting an instance name folds it in (`kafka` vs `kafka:orders`).
- `[kFeatureConfigure]` runs after configuration has resolved and before the container initializes: `config` is readable and binding is open. `[kFeatureBootstrap]` is optional and runs after `container.init()`; look up bindings there. Its kit carries the application's logger.
- An HTTP feature implements `HTTPFeature` from `@caffeinejs/http`, which adds `[kFeatureServer]`: handed the server at the feature's install position, after the container has initialized, with the same `HTTPSetupContext` a plugin factory receives. It is a property, not a method, so a feature written for one server does not compile on an application running another.
- `HTTPFeature` states that kit as `HTTPSetupContext` with no `C`: a typed parameter on a property would make the interface invariant in `C`, and `function portOf(app: WebApplication)` could no longer take a configured application. `HTTPFeatureBuilder` restores it, so a subclass's `server(instance, kit)` reads `HTTPSetupContext<C>`.
- Most features extend `FeatureBuilder<C>` from `@caffeinejs/std`, which does one thing: it runs the application's configure callbacks against the builder, with the resolved configuration, immediately before `configure`. A subclass names itself, holds what its fluent methods set in ordinary fields, and binds in `configure`.
- The application's callback is `(builder, kit)`. The kit is the `FeatureConfigureKit` the feature's own `configure` receives: `config`, `store`, and `container.bind(...)`, but no `container.get(...)` yet. A plugin's builder callback is `HTTPPluginConfigurer` and is handed the `HTTPSetupContext`, where the container resolves and binding is closed.
- An HTTP feature extends `HTTPFeatureBuilder<C>` and wires the server in `server`:

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

- The package exports a factory function, generic over the application configuration type. An HTTP feature's factory returns `HTTPFeature<C>`, not `Feature<C>`, or the server it is written against goes unchecked:

```ts
export function thing<C = unknown>(configure?: FeatureConfigurer<ThingBuilder<C>, C>): HTTPFeature<C> {
  return new ThingBuilder<C>(configure as never)
}
```

- A feature taking an instance name overloads on it and folds it into `[kFeatureName]`:

```ts
export function thing<C = unknown>(configure?: FeatureConfigurer<ThingBuilder<C>, C>): HTTPFeature<C>
export function thing<C = unknown>(instance: string, configure?: FeatureConfigurer<ThingBuilder<C>, C>): HTTPFeature<C>
```

- Only the framework's pre-registered builders (shutdown policy, logger, cookies, error handling) hand a callback over with `builder[kAddConfigurer](configure)`, because they are constructed before an application can name one. Nothing else uses that symbol.
- A feature the application cannot configure implements `Feature` / `HTTPFeature` directly, not `FeatureBuilder`: `AuthorizationBuilder` and `GuardsBuilder`. Having nothing to configure is what decides it, not how much work the phases do.

## Error messages

- Sentence case; no trailing period; no contractions (`does not`, not `doesn't`)
- Active voice: `Cannot X` not `Unable to X` or `Failed to X`
- Colon for detail: `Cannot do X: reason`
- Double-quote user-supplied values: `"${keyStr(key)}"`
- Class prefix `Err`: `ErrNoResolutionForKey`, not `NoResolutionForKeyError`
- `.name` and `code` align: `ErrFoo` → `this.name = 'ErrFoo'`, `code = 'ERR_FOO'`
- Fixed, context-free solutions may call `solutions()` in the constructor. Contextual errors call `solutions()` at the throw site.

## Documentation

TSDoc is the **published contract** (`.d.ts` / hover), not git history. Write for the caller. Summary sentence first; details after a blank line. Do not document every export. Do not add internal implementation details in the TSDocs.

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

## Third-party library docs

Before relying on the API of a third-party library, call the Context7 MCP server. Do this while implementing, not only when asked for documentation. Use the version this repository depends on, from that package's `package.json`.

1. `resolve-library-id` with the library name and what to look up.
2. `query-docs` with the chosen `/org/project` id. One concept per call.
3. Answer from those docs. Prefer Context7 over web search for a library API.

Skip Context7 for `@caffeinejs/*`, language builtins, and code already in the conversation. First-party behavior is in this file, [`AGENTS.md`](AGENTS.md), and the package `AGENTS.md`.

## Analysis servers

- SonarQube: query the files in the change, or set `pullRequest` to the pull request number. Never load the full issue list. Never change an issue's status. The quality-gate status returns `NONE` for this project; it is neither a pass nor a fail, use issue search.
- The GitHub MCP server is read-only. Open and merge pull requests with `gh`.
- Scorecard scores and Dependabot alerts are signals, not a verdict.

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

That rule holds for this repository without exception. An **application** that must use a library shipping only legacy decorators (TypeORM, class-validator) reaches for the library's decorator-free API, or compiles those files as a separate TypeScript project and consumes only its output — [`ai/docs/mixing-decorators.md`](ai/docs/mixing-decorators.md).

## Git discipline

Never use `git stash`. If uncommitted changes exist and you need to switch state, stop and ask.

Never revert, discard, or `git checkout --` a file outside the current task’s scope — including files a tool (e.g. `oxlint --fix` / `oxfmt`) modified as a side effect. That uncommitted state is other in-progress work. Stop and report it; do not revert it yourself.
