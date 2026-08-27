# Claude Code Guidelines

User-app and framework-usage agent files live in [`ai/`](ai/). This file is **contributor** rules for this repository. Do not copy it into application repos.

## Import style

Group all imports from the same module into a single import statement. Do not split them across multiple lines. This is enforced by `import-x/no-duplicates`.

```ts
// correct
import { Binder, BindTo } from './Binder.js'

// wrong
import { Binder } from './Binder.js'
import { BindTo } from './Binder.js'
```

## After every edit

After making any code changes, always run checks in this order and fix any failures before considering the task complete. Scope the checks to what actually changed:

- **Single workspace package touched** (one directory from the root `package.json` `workspaces` list — e.g. only `http/**`): scope every command to that package.
  1. `npm run build -w <pkg>` — must compile without errors
  2. `npm run test:typecheck -w <pkg> --if-present` — most packages have no package-level `test:typecheck` script (vitest's own typecheck, visible as `Type Errors` in its output, already covers test files); the flag makes this a no-op instead of a failure when absent
  3. `npm test -w <pkg>` — all tests in that package must pass
  4. `npm run lint:fix -- <pkg-path>` — zero errors in that package (warnings are pre-existing and acceptable)
- **Anything wider** — two or more workspace packages touched, or any file outside every package directory (root `tsconfig*.json`, `eslint.config.js`, root `package.json`, `vitest.workspace.ts`, `.github/**`, this file): run the full, unscoped suite exactly as below, since a cross-cutting change can break a package the diff never touched.
  1. `npm run build`
  2. `npm run test:typecheck`
  3. `npm test`
  4. `npm run lint:fix`

When in doubt about which bucket a change falls into, run the full suite.

## Private modules

Files prefixed with `_` (e.g., `_noop.ts`) are private to their directory. Do not import them from a different directory. This is enforced by the `no-restricted-imports` ESLint rule.

```ts
// correct — same directory
import { noop } from './_noop.js'

// wrong — cross-directory
import { noop } from '../_noop.js'
```

## Error messages

- Sentence case: start with a capital letter
- No trailing period
- No contractions: `does not` not `doesn't`, `could not` not `couldn't`
- Active voice: `Cannot X` not `Unable to X` or `Failed to X`
- Colon for detail: `Cannot do X: reason` not `Cannot do X. Reason.`
- Double-quote user-supplied values: `"${keyStr(key)}"` not `'${keyStr(key)}'`
- Name error classes with the `Err` prefix: `ErrNoResolutionForKey`, not `NoResolutionForKeyError`. This follows the Rust/Go convention — a deliberate choice diverging from the JS `SomethingError` suffix norm.
- The `.name` property and `code` string must align with the class name: `ErrFoo` → `this.name = 'ErrFoo'`, `code = 'ERR_FOO'`
- Errors with fixed, context-free solutions may call `solutions()` inside their constructor. Contextual errors with variable message content call `solutions()` at the throw site.

## Acronym casing

Acronyms and initialisms carry a **single consistent case** — never JS Title-case. Follow the Go convention: `URL` not `Url`, `ID` not `Id`, `OIDC` not `Oidc`, `HTTP` not `Http`, `JSON` not `Json`.

- **PascalCase** (types, classes, enum members): acronym always uppercase — `HTTPClient`, `OIDCConfig`, `JWTVerifier`, `ErrOIDCCallback`.
- **camelCase** (vars, methods, params, properties): a **leading** acronym is fully lowercased; a **mid/trailing** acronym is fully uppercased.
- `SCREAMING_SNAKE` (error `code`, env vars) already conforms — `ERR_OIDC_CALLBACK` is unchanged.

```ts
// correct
class HTTPClient {}
const oidcConfig = {}
function parseJSON(s: string) {}
const clientID = ''
const authURL = ''

// wrong
class HttpClient {}
const OidcConfig = {}
function parseJson(s: string) {}
const clientId = ''
const authUrl = ''
```

Exceptions:

1. **`IoC`** stays stylized — `CaffeineIoC`, `IoC`. Deliberate brand exception, not `IOC`.
2. **External / interop names** that mirror a third-party contract keep the upstream spelling: Node (`IncomingHttpHeaders`, `EnvHttpProxyAgent`, `executionAsyncId`, `checkServerIdentity`, `urlToHttpOptions`), WebCrypto (`AlgorithmIdentifier`, `JsonWebKey`, `JsonWebKeyInput`), inspector/CDP (`BreakpointId`, `CallFrameId`, `ExecutionContextId`), fast-check (`fc.webUrl`), ESLint (`messageId`), JS built-ins (`toJSON`).
3. **Wire / protocol tokens** are data, not identifiers — leave them exactly as the spec writes them: the `Set-Cookie` attribute `HttpOnly` (RFC 6265), OIDC/OAuth snake_case params (`client_id`, `redirect_uri`, `jwks_uri`), and the JOSE `typ` values (`oidc-state+jwt`). Only the surrounding TS identifiers change (`redirectUri` → `redirectURI`), never the string sent on the wire.
4. **A substring is not an acronym** — `Identity`, `Identifier`, `Candidate`, `Validate`, `Hidden` merely contain acronym letters. Never rewrite them.

## Inline type imports

Never use inline dynamic-import syntax as a type reference (`import('node:stream').Readable`). Always declare a top-level `import type` statement and reference the type by name.

```ts
// correct
import type { Readable } from 'node:stream'
async upload(stream: Readable) { ... }

// wrong
async upload(stream: import('node:stream').Readable) { ... }
```

## Import extensions

All imports must include the `.js` extension, including TypeScript source files.

```ts
// correct
import { CaffeineIoC } from './container.js'
import { Binding } from './binding.js'

// wrong
import { CaffeineIoC } from './container'
import { Binding } from './Binding'
```

## Re-exports

Do not re-export a symbol (type **or** value) from another module or package just to "keep a surface stable" or give it a shorter import path. This includes a standalone passthrough file and a single re-export line buried in an otherwise-legitimate module. Import the symbol from its source directly at every use site, even if that means two import statements (one per source module).

```ts
// wrong — a line that forwards std's symbols so local files can import them from here
export { kServiceConfigure, type Service } from '@caffeinejs/std'

// wrong — a whole module that exists only to forward types
export type { Augment, Plugin, PluginContext } from '@caffeinejs/std'

// correct — import from the source at the use site; keep local imports on their own line
import { kServiceConfigure, type Service } from '@caffeinejs/std'
import type { ServiceKit } from './service.js'
```

A package's `index.ts` barrel aggregating that package's **own** modules is not a passthrough and is fine.

## Monorepo structure

Packages: `di` (`@caffeinejs/di`), `http` (`@caffeinejs/http`), `http-multipart` (`@caffeinejs/http-multipart`). Examples live under `di/examples/`. Shared build tooling lives in `tools/`.

Cross-package imports use the package name, not relative paths across workspace boundaries.

```ts
// correct — from http package
import { CaffeineIoC } from '@caffeinejs/di'

// wrong — leaks internal paths
import { CaffeineIoC } from '../di/container.js'
```

## Decorators

This project uses **TC39 ECMAScript decorators** (Stage 3 spec) only. Do not use TypeScript's legacy experimental decorators.

- Root `tsconfig.json` sets `"lib": ["Decorators", "esnext.decorators"]` — no `experimentalDecorators`, no `emitDecoratorMetadata`, no `reflect-metadata`
- Never add `experimentalDecorators: true` or `emitDecoratorMetadata: true` to any `tsconfig.json` in the main packages
- `tsconfig.legacy.json` and the NestJS benchmark configs intentionally use the legacy flags for third-party comparison only — do not copy those settings

## Git discipline

Never use `git stash` under any circumstances. Not to save work, not to switch context, not to resolve conflicts. No exceptions. If uncommitted changes exist and you need to switch state, stop and ask for guidance.

Never revert, discard, or `git checkout --` a file outside the current task's scope — including files a tool (e.g. `eslint --fix`) modified as a side effect of running against unrelated paths. That file's uncommitted state belongs to other in-progress work you don't have full context on; reverting it destroys work that isn't yours to discard. If a command unexpectedly touches an unrelated file, stop and report it — do not revert it yourself, even to be "safe." Ask the user how they want it handled.

## Build system

- `npm run build` at the root compiles all packages via `tsc --build` (project references).
- Do not edit `dist/` by hand.

## CI build outputs

`.github/workflows/ci.yml` has one `build` job producing `dist/` for each package, then a separate `test` job that only receives the dists explicitly listed — it does not rebuild. Whenever a **new workspace package** is added that has its own `dist/` (declares `"types": "dist/..."` or `"exports"` pointing into `dist/`) **and** is imported by another package's tests (i.e. it has an entry in the root `vitest.workspace.ts` `projects` list, directly or via a dependent project), add its dist path to **both**:

1. The `for d in ...` list in the `Verify Build Outputs` step
2. The `path:` list in the `Upload Build Artifacts` step

Missing either one does not fail the `build` job — it only surfaces later as a `vite:import-analysis` "Failed to resolve entry for package" error in the `test` job, since that package's dist never reached the test runner. A package with no cross-package test consumers (e.g. `scan`, only used by `di/examples/*`) does not need this.

## npm scripts

The root `.npmrc` sets `ignore-scripts=true` (a deliberate supply-chain guard). This suppresses dependency install scripts **and** npm's own `pre*`/`post*` run-hooks and `postinstall` (npm 11). Consequently, any "run X automatically before Y" must be triggered explicitly — never a lifecycle hook, which will silently never fire. An explicit `npm run <name>` still executes under `ignore-scripts`; only auto-hooks are suppressed.

Keep package-specific setup out of the root scripts. The petstore example has two generated, untracked artifacts its specs import — the Prisma client and `src/__caffeine__.gen.ts` (`caffeine generate`). Rather than chaining codegen into the root `test`/`test:typecheck` (which would fire for every unrelated package), the petstore regenerates them in its **own vitest `globalSetup`** ([examples/03-petstore/vitest.globalsetup.ts](examples/03-petstore/vitest.globalsetup.ts) → `npm run generate`), so codegen runs only when the petstore's own vitest project runs. Its CI build job also generates them (via `npm run build --workspaces`) before the root type-check.

`@caffeinejs/cli` ships a bun-compiled binary at `cli/dist/caffeine`. Root `npm run build` (`tsc`) does not produce it — run `npm run build:cli` (or `make build:cli`) after clone/clean so `node_modules/.bin/caffeine` exists before any example `caffeine generate`. `build:examples` and CI already call `build:cli` first.
