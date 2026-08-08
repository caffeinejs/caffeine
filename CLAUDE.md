# Claude Code Guidelines

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

After making any code changes, always run the following checks in order and fix any failures before considering the task complete:

1. `npm run build` — must compile without errors
2. `npm run test:typecheck` — type-check all test files
3. `npm test` — all tests must pass
4. `npm run lint:fix` — zero errors (warnings are pre-existing and acceptable)

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

## Monorepo structure

Packages: `di` (`@caffeinejs/di`), `http` (`@caffeinejs/http`), `http-fastify-adapter` (`@caffeinejs/http-fastify-adapter`). Examples live under `di/examples/`. Shared build tooling lives in `tools/`.

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

## npm scripts

The root `.npmrc` sets `ignore-scripts=true` (a deliberate supply-chain guard). This suppresses dependency install scripts **and** npm's own `pre*`/`post*` run-hooks and `postinstall` (npm 11). Consequently, any "run X automatically before Y" must be an **explicit in-script `&&` chain**, never a lifecycle hook — a `pretest` hook will silently never fire.

Reference pattern: the petstore's Prisma client must be generated before it type-checks, so `prisma:generate` is chained directly into the scripts that touch it:

```jsonc
"test": "npm run prisma:generate && vitest run",
"test:coverage": "npm run prisma:generate && vitest run --coverage",
"test:typecheck": "npm run prisma:generate && tsc -p tsconfig.test.json"
```

An explicit `npm run <name>` still executes under `ignore-scripts`; only auto-hooks are suppressed.
