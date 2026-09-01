# Contributor coding conventions

How to change **this** monorepo. Behavioral rules for agents live in [`AGENTS.md`](AGENTS.md). User-app and framework-usage agent files live in [`ai/`](ai/). Do not copy this file into application repos.

## Glossary

In this repository these names mean **this project**, not a third-party library:

| You say | It means |
|---|---|
| Caffeine Framework, Caffeine, CaffeineJS | This monorepo (`caffeinejs/caffeine`). npm scope `@caffeinejs/*`. |
| CaffeineIoC | `@caffeinejs/di` — the container. Brand spelling `IoC`, not `IOC`. |
| Caffeine HTTP, the HTTP package | `@caffeinejs/http` (Fastify adapter). |

Package names (`@caffeinejs/kafka`, …) are the npm names. Workspace dirs are in the table below.

This is not NestJS, Express, or Spring Boot. Do not use `experimentalDecorators`, `emitDecoratorMetadata`, `reflect-metadata`, Nest `@Module` / `forRoot`.

When editing a first-party package, also read that package’s `AGENTS.md`:

| Directory | Package |
|---|---|
| [`di/`](di/AGENTS.md) | `@caffeinejs/di` |
| [`http/`](http/AGENTS.md) | `@caffeinejs/http` |
| [`kafka/`](kafka/AGENTS.md) | `@caffeinejs/kafka` |
| [`openapi/`](openapi/AGENTS.md) | `@caffeinejs/openapi` |
| [`messaging/`](messaging/AGENTS.md) | `@caffeinejs/messaging` |
| [`std/`](std/AGENTS.md) | `@caffeinejs/std` |
| [`static/`](static/AGENTS.md) | `@caffeinejs/static` |
| [`view/`](view/AGENTS.md) | `@caffeinejs/view` |
| [`multipart/`](multipart/AGENTS.md) | `@caffeinejs/multipart` |
| [`scan/`](scan/AGENTS.md) | `@caffeinejs/scan` |
| [`cli/`](cli/AGENTS.md) | `@caffeinejs/cli` |
| [`testing/`](testing/AGENTS.md) | `@caffeinejs/testing` |
| [`brewer/`](brewer/AGENTS.md) | `@caffeinejs/brewer` |
| [`devtools/`](devtools/AGENTS.md) | `@caffeinejs/devtools` |
| [`fetchy/fetchy/`](fetchy/fetchy/AGENTS.md) | `@caffeinejs/fetchy` |
| [`fetchy/fetchy-undici/`](fetchy/fetchy-undici/AGENTS.md) | `@caffeinejs/fetchy-undici` |
| [`fetchy/fetchy-logging-interceptor/`](fetchy/fetchy-logging-interceptor/AGENTS.md) | `@caffeinejs/fetchy-logging-interceptor` |
| [`plugins/eslint/`](plugins/eslint/AGENTS.md) | `@caffeinejs/eslint-plugin` |
| [`plugins/esbuild/`](plugins/esbuild/AGENTS.md) | `@caffeinejs/esbuild-plugin` |
| [`plugins/vite/`](plugins/vite/AGENTS.md) | `@caffeinejs/vite-plugin` |

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
- **Anything wider** — two or more workspace packages, or any non-md file outside every package directory (root `tsconfig*.json`, `eslint.config.js`, root `package.json`, `vitest.workspace.ts`, `.github/**`):
  1. `npm run build`
  2. `npm run test:typecheck`
  3. `npm test`
  4. `npm run lint:fix`

Docs-only does not apply to TSDoc inside `.ts`, `ai/llms.txt`, YAML, JSON, or a mixed markdown-and-code diff. One non-md file means this is not docs-only.

When in doubt on **code** scope, run the full suite. A README next to a TypeScript change does not make the task docs-only.

Root `npm run test:typecheck` is two `tsc` projects: [`tsconfig.test.colocated.json`](tsconfig.test.colocated.json) (tests under `di` / `http` / `multipart` / `static` / `view`, `paths` to **source**) and [`tsconfig.test.json`](tsconfig.test.json) (everything else, via `exports` → `dist/*.d.ts`). Rebuild touched packages before typecheck when public types change. Repeat local runs reuse `.cache/tsconfig.test*.tsbuildinfo` (gitignored).

Root `npm run build` is `tsc --build` (project references). Do not edit `dist/` by hand.

The root `.npmrc` sets `ignore-scripts=true`. Never rely on npm `pre*` / `post*` / `postinstall` hooks; they will not fire. Explicit `npm run <name>` still runs.

## Import style

Group all imports from the same module into a single import statement. Enforced by `import-x/no-duplicates`.

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
export { kServiceConfigure, type Service } from '@caffeinejs/std'

// correct
import { kServiceConfigure, type Service } from '@caffeinejs/std'
import type { Services } from './service.js'
```

A package’s `index.ts` barrel aggregating that package’s **own** modules is not a passthrough and is fine.

## Where a feature puts what it produces

Where a value goes depends on who reads it, not on what is convenient:

| The value is… | Goes to | Read with |
|---|---|---|
| a setting a user tunes from the environment or a file | a config slice, in `beforeBootstrap` | `defineFeatureConfig(...)` → `slice.config` |
| something user code injects | a container binding, in `bootstrap` | `container.get` / constructor injection |
| one of many providers a single consumer collects | a container binding with `.extends()` | `container.getManyOptional(Base)` |
| an extension's own data | that extension's **constructor** | the field |
| a framework value the application needs once everything is up | a contribution, in `bootstrap` | `app.contributions.get(key)` |

Do not route an extension's own configuration through a container key it reads back at server setup: the
builder is holding the value when it constructs the extension. `bind(X).toValue(new X(data)).extends()`.

Contributions are write-only while services bootstrap and sealed the moment they finish, because services
bootstrap concurrently — a read before the seal would be answered by whichever service the scheduler reached
first. Keys are made with `contributionKey<T>('namespace:name')`; the type argument is required.

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

TC39 ECMAScript decorators only. Root `tsconfig.json` sets `"lib": ["Decorators", "esnext.decorators"]`. Never add `experimentalDecorators` or `emitDecoratorMetadata` to main-package tsconfigs. `tsconfig.legacy.json` and NestJS benchmark configs use the legacy flags for comparison only — do not copy them.

## Git discipline

Never use `git stash`. If uncommitted changes exist and you need to switch state, stop and ask.

Never revert, discard, or `git checkout --` a file outside the current task’s scope — including files a tool (e.g. `eslint --fix`) modified as a side effect. That uncommitted state is other in-progress work. Stop and report it; do not revert it yourself.
