# Contributor coding conventions

How to change **this** monorepo. Agent behavior is in [`AGENTS.md`](AGENTS.md); writing a feature or a plugin is in [`FEATURES.md`](FEATURES.md).

## Glossary

In this repository these names mean **this project**, not a third-party library:

| You say                                  | It means                                                           |
| ---------------------------------------- | ------------------------------------------------------------------ |
| Caffeine Framework, Caffeine, CaffeineJS | This monorepo (`caffeinejs/caffeine`). npm scope `@caffeinejs/*`.  |
| CaffeineIoC                              | `@caffeinejs/di` — the container. Brand spelling `IoC`, not `IOC`. |
| Caffeine HTTP, the HTTP package          | `@caffeinejs/http` (Fastify adapter).                              |

This is not NestJS, Express, or Spring Boot.

Package names (`@caffeinejs/kafka`, …) are the npm names; each workspace's `package.json` gives its own. Workspace membership is the root [`package.json`](package.json) `workspaces` list. Cross-package imports use the package name (`@caffeinejs/di`), not a relative path into another package.

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
  1. `make check`, and nothing else. It runs the pin check, the error message copies, `build`, `lint:fix`, `lint:markdown`, `spec:check`, the CLI binary, `build:examples`, `test:typecheck`, `test:memory` and `npm test`, in that order, so running any of them first only runs it twice.

One non-md file means the task is not docs-only: TSDoc inside `.ts`, `ai/llms.txt`, YAML, JSON, and a README next to a TypeScript change all count as code. When in doubt on code scope, run `make check`.

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
- A generated `*.gen.ts` file is compiled like any source, so no `tsconfig.build.json` excludes it, but coverage and analysis leave it out: its source is measured where it lives.
- `npm run build` is `tsc --build tsconfig.build.json`; `npm run test:typecheck` is `tsc --build tsconfig.check.json`. Both are incremental. Never edit `dist/` by hand.
- A green `npm run build` says nothing about tests: only a check project reads a test file. Vitest type-checks only where a config turns it on (`brewer/` and `testing/`, through their own `tsconfig.vitest.json`); `npm test` elsewhere runs tests it never type-checked.
- `cli/` and `benchmarks/` are outside `tsconfig.check.json` and own a `test:typecheck` script; they are the only workspaces where `npm run test:typecheck -w <pkg>` does anything. `devtools/ui` and `examples/**` are type-checked by nothing.
- Tests resolve `@caffeinejs/*` through package `exports` to `dist/*.d.ts`. There is no `source` condition and no `paths` map, so a type-check needs the dependency `dist/` to exist: build first.
- The root `.npmrc` sets `ignore-scripts=true`. Never rely on npm `pre*` / `post*` / `postinstall` hooks; they will not fire. Explicit `npm run <name>` still runs.

## Imports and modules

- One import statement per module (`import/no-duplicates`). Every relative import ends in `.js`, TypeScript sources included.
- A type from another module comes in through a top-level `import type`, never an inline `import('…')` type.
- A file prefixed with `_` (`_noop.ts`) is private to its directory: never import it from another one (`no-restricted-imports`).
- Do not re-export a symbol (type or value) from another module or package just to keep a surface stable or shorten an import path. Import it from its source at every use site. A package's `index.ts` aggregating the package's **own** modules is not a passthrough and is fine.

```ts
// correct
import { Binder, BindTo } from './Binder.js'
import type { Readable } from 'node:stream'
import { noop } from './_noop.js'
import { kFeatureConfigure, type FeatureConfigureKit } from '@caffeinejs/application'

// wrong
import { Binder } from './Binder.js'
import { BindTo } from './Binder.js'
import { CaffeineIoC } from './container'
import { noop } from '../_noop.js'
export { kFeatureConfigure, type FeatureConfigureKit } from '@caffeinejs/application'
async upload(stream: import('node:stream').Readable) { ... }
```

### Module layout

A module is a directory of source files in a library package (not `benchmarks/`, `examples/`, `di/examples/` or `devtools/ui`).

- It has a main file named after it (`cache/cache.ts`, `circuit_breaker/circuit_breaker.ts`) and an `index.ts` barrel that only re-exports.
- A directory of independent files with no main one (`decorators/`, `internal/`, `provider/`) has the barrel alone.
- A barrel publishes what the package offers. A helper only the package's own code uses stays out of it and is imported by its path.
- Exempt: a package root, whose `index.ts` is the entry (`std/` has none); a directory holding only subdirectories; `_`-prefixed directories (`_tests/`, `_testdata/`, `_spectypes/`, `_spec/`).
- A new or moved module follows these rules. An existing one keeps its layout until a change asks to move it.

### Renames

Every package is unreleased (`0.0.0`). A rename updates every caller in the same change and leaves no alias, re-export or deprecation shim behind.

## Features and plugins

Before writing or changing a feature, a plugin factory or a feature's configuration schema, read [`FEATURES.md`](FEATURES.md).

## Durations and byte sizes

A span of time in a public API (an option, a builder method, an SPI parameter, a decorator argument, an event or error field) is a `Duration` from `@caffeinejs/std/duration`: a number of milliseconds, as Go's `time.Duration` is a number of nanoseconds. A size in bytes is a `ByteSize` from `@caffeinejs/std/bytes`: a count of bytes. Both follow the same rules:

- **Named without a unit**: `timeout`, `ttl`, `waited`, `maxSize`, `bodyLimit`; never `timeoutMs`, `ttlSeconds`, `maxSizeBytes` or `limitKb`. The identifier follows the acronym rules (`sessionCookieTTL`), the configuration key the environment folding (`sessionCookieTtl`).
- **Code writes it with the constants**: `5 * Second`, `100 * Millisecond`, `30 * Day`, `512 * KiB`, `10 * MiB`. A default is written the same way, never as a bare count (`1048576`, `1024 * 1024`). A test's payload length (`'x'.repeat(n)`, `Buffer.alloc(n)`) is data, not a size an API takes, and this rule does not reach it.
- **Text is read in two places only**: `$t.Duration()` or `$t.Bytes()` in a configuration schema, and `parseDuration` / `duration(...)` or `parseBytes` / `bytes(...)` in code. No option takes `Duration | string` or `ByteSize | string`.
- **A message prints it with `formatDuration(d)` or `formatBytes(n)`**, or as `${d}ms` or `${n} bytes`; a solution names code: `such as 30 * Second`, `such as 1 * MiB`. A log line keeps its key and the unit the key names (`ttlMs`, `ageSeconds`, `bytes`), with the value converted.
- **A library's own option shape keeps the library's type and unit** (Fastify, jose, undici, `@fastify/static`, `@fastify/multipart`'s `limits`, `lru-cache`). An application fills it with the constants, or with `duration('7d')` or `bytes('10mb')` for text.
- `kafka/` and `messaging/` still take bare-number durations (`nackDelay`, `idleTimeout`). Do not copy them.

### Durations

- The grammar is Go's plus `d` for a day (`'90s'`, `'1h30m'`, `'7d'`); configuration refuses a sign and a bare number.
- **Seconds exist only on the wire**, converted where they are written: `Math.floor(d / Second)` for `Max-Age`, `Cache-Control`, a token's `exp` and OIDC `max_age`, and `d / Second` for an OpenTelemetry histogram in seconds. A value read off the wire in seconds, such as `expires_in`, becomes a `Duration` at once.
- **A lifetime written in whole seconds is at least one**: a scheme truncates its own (`truncate(ttl, Second)`), and refuses one under a second when it is built, where it would go out as `Max-Age=0` or an `exp` already past. `ctx.cookie(...)` refuses a `maxAge` that is not whole seconds. A tolerance on time claims is floored, `Math.floor(d / Second)`, everywhere it is checked.
- **A sink that takes whole milliseconds gets `Math.ceil(d)`**: `AbortSignal.timeout`, Fastify's `handlerTimeout`, Redis `PX`, undici's headers and body timeouts.

### Byte sizes

- **Every unit is binary**, the constants and the text alike: `'1kb'` is `1 * KiB`. There is no decimal `KB`, which would make `1 * KB` and `bytes('1kb')` disagree.
- The grammar is Docker Compose's: an integer and an optional `b`, `k`/`kb`, `m`/`mb`, `g`/`gb`, `t`/`tb` or `p`/`pb`, in any case (`'512kb'`, `'1Gb'`). A bare amount is bytes, in configuration too; a sign, a fraction and the Kubernetes spellings (`'1Ki'`, `'1MiB'`) are refused.
- **A limit a specification states keeps the specification's number**: a cookie's 4096 octets, not `4 * KiB`.

## Error messages

A person reads the message in a terminal and a coding agent reads it in a log. Both act on the text alone, so it says what failed, why, and what to do next.

- Sentence case; no trailing period; no contractions (`does not`, not `doesn't`)
- Active voice: `Cannot X` not `Unable to X` or `Failed to X`
- Colon for detail: `Cannot do X: reason`
- Double-quote user-supplied values: `"${keyStr(key)}"`
- Class prefix `Err`: `ErrNoResolutionForKey`, not `NoResolutionForKeyError`
- `.name` and `code` align: `ErrFoo` → `this.name = 'ErrFoo'`, `code = 'ERR_FOO'`
- The first line stands alone: what failed and why, naming the exact key, route, option or file the reader can search for. Logs and tools often keep only that line.
- Plain text: no ANSI codes, no markdown, no emoji. Never a secret, a token or a request body.

### Solutions and links

Build a message that carries solutions or links with `errMessage(...)` from `@caffeinejs/std/err`. Never hand-write a `Possible Solutions` block, a bullet or a URL.

```ts
// correct
throw new ErrConfiguration(
  errMessage(`Cannot set the base path: "${value}" does not start with "/"`)
    .solutions(`Write it as "/${base}"`)
    .reference('@caffeinejs/http', ErrConfiguration)
    .build(),
)

// wrong
throw new ErrConfiguration(`Cannot set the base path: "${value}" does not start with "/"\n  - Write it as "/${base}"`)
```

- A solution is one action the reader can take now: imperative, naming the exact method, option or decorator, most likely fix first. `Check your configuration` is not a solution.
- No leading dash and no trailing period: the builder writes the bullets.
- Fixed, context-free solutions go in the constructor. Solutions that depend on the call go at the throw site. A class whose first line is fixed takes the site's solutions as a rest parameter and builds the message itself, as `ErrFeatureNotInstalled(feature, ...solutions)` does; a class that takes a free-form message takes it finished.
- Every first-party error message carries `.reference(package, ErrClass)`, added where the message is written: in the constructor of a class that writes its own text, at the construction site or the factory of a class that takes a message. `package` is the package that defines the class, not the one throwing it. Nothing is printed until the error pages are published. A warning takes none.
- An `ErrHTTP` message is the response body a client reads, so neither an `ErrHTTP` nor any subclass of it (`ErrCSRFCrossOrigin`, `ErrRefreshTokenRejected`) carries solutions or a reference.
- On a hot path, a class may build its footer once, in a static field, and append it to the text it writes: `ErrCallNotPermitted` does, because refusals come in bulk.
- `.links(...)` adds further reading.
- The builder lives in `std/err/message.ts` and imports nothing. A package that cannot depend on `std` gets a generated copy, a `*.gen.ts` file whose path [`tools/copy-err-message.json`](tools/copy-err-message.json) gives. Never edit a copy: change the source and run `make err-message`, which `make check` also runs. A change to the source changes every package with a copy, so it takes `make check`.

## Documentation

TSDoc is the **published contract** (`.d.ts` / hover), not git history. Write for the caller: a summary sentence first, details after a blank line.

- Write it when behavior surprises, sibling APIs look alike, callers must handle a specific `Err*` (`@throws`), a parameter's meaning is not its name, or a generic or overload is not obvious. Do not document every export.
- Do not restate the type, narrate the implementation or add internal details. Do not document tests, obvious getters or private `_` modules.
- No design history in hover ("we rejected Nest"). Do document an observable why when it **is** the contract (headers stay open because Ajv `removeAdditional` would strip `host`).
- Do not analogize to Nest, Spring, ASP.NET, or Express in docs or TSDoc. Naming this package's real peer (Fastify in `@caffeinejs/http`) is allowed when the reader must know it.
- Every API an `@example`, a README or a doc page shows exists today, with the signature shown: TC39 decorators have no parameter form, and a token an example injects is one a package exports.
- Tags: `{@link Symbol}`; `@param name -` only when the name is insufficient; `@throws`; `@example` only for call shapes types hide. Skip `@returns` unless the meaning is not the type. No `@class`, `@function`, or `@type`.
- Voice: sentence case; complete sentences; same acronym rules as identifiers. No `NOTE:`, `IMPORTANT:`, or changelogs.

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

Skip Context7 for `@caffeinejs/*`, language builtins, and code already in the conversation. First-party behavior is in this file, [`FEATURES.md`](FEATURES.md), [`AGENTS.md`](AGENTS.md), and the package `AGENTS.md`.

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

TC39 ECMAScript decorators only. Root `tsconfig.json` sets `"lib": ["Decorators", "esnext.decorators"]`. Never add `experimentalDecorators` or `emitDecoratorMetadata` to main-package tsconfigs, and never use `reflect-metadata` or Nest's `@Module` / `forRoot`. The NestJS benchmark configs use the legacy flags for comparison only — do not copy them.

An **application** that must use a library shipping only legacy decorators (TypeORM, class-validator) reaches for the library's decorator-free API, or compiles those files as a separate TypeScript project and consumes only its output — [`ai/docs/mixing-decorators.md`](ai/docs/mixing-decorators.md).

## Tests

- **Test behavior, not implementation.** A test calls what the module exports, the way its caller does, and asserts what that caller observes: a return value, a thrown `Err*` and its `code`, a response, a bound value, an event. It never reads a private field or symbol, spies on a function the caller cannot reach, or pins the order of internal calls. A refactor that keeps behavior keeps every test green.
- **Every assertion can fail.** Assert the exact value: `toBe(null)`, not `toBeDefined()` on something that can be `null`; the exact count, not `> 0`. A test that still passes with the behavior it names broken is wrong. Name a test after the behavior and why it matters, not after the function it calls.
- **A test of one module sits beside it, named after it**: `cache.ts`, `cache.test.ts`. A variant keeps the stem: `cache.prop.test.ts`, `cache.test-d.ts`.
- **A wider test goes in `_tests/`** of the nearest directory that holds everything it exercises: one that crosses modules, or boots a container, an application or a server. Its helpers sit beside it in `_tests/` and its fixtures in `_testdata/`. A test across packages, or of the repository itself, goes in the root `test/`. The directory is `_tests/`, the name every exclude above carries: a helper outside it, unless it is a `*.testkit.ts`, ships in `dist/`.
- **Fix a bug test-first.** Before changing code for a bug, or for an issue a review or a tool reports, write the test that reproduces it and run it. It must fail, and for the reason reported, not a typo or a missing import. A test you cannot make fail means the issue is not what you thought: stop, say so, and change nothing. Then fix it, see the same test pass, and keep the test in the change.
- An existing test keeps its place. Move one only when asked.

### Time in tests

A test that sleeps for something to happen fails once the machine is busy: a full run executes many files at once, and a timer can fire hundreds of milliseconds late. Wait on what the test asserts, never on a stretch of time standing in for it.

- That something happened (a request reached its handler, a hook ran) is a latch: the code resolves `started` and awaits `held`, which the test releases at the end (`http/core/listener/_tests/lifecycle.test.ts`).
- That time passed is a driven clock: `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })`, with `'Date'` added when the code compares `Date.now()` with a deadline, then `await vi.advanceTimersByTimeAsync(ms)`. A test that also runs a server, a socket or a third-party SDK fakes that list and nothing else.
- Fake after `bootstrap()` or `run()`, and fake `setTimeout` only after the file's first global `fetch`: undici builds its own clock on first use, and one built fake never ticks again in that file.
- `vi.useRealTimers()` drops every pending fake timer for good: advance past each one a close waits on before restoring. `afterEach` restores before it closes anything, and runs `await vi.runOnlyPendingTimersAsync()` first when its close could join one a failed test left waiting.
- Where a timer must stay real, such as an SDK's export callback, freeze the clock instead: `toFake: ['Date']` alone, with the test's own deadlines on `performance.now()`. A frozen clock proves nothing about time passing: a claim that something lapses, or is kept from lapsing, drives the clock.
- Never `vi.waitFor` or `expect.poll` with anything faked: every attempt moves the fake clock.
- A wait no clock stands in for, such as a worker thread starting, gets a budget in seconds (`describe(name, { timeout: 30_000 }, ...)`) and fails as soon as the other side exits.

## Security

- Pin every GitHub Action to a full commit SHA with the version as a trailing comment: `uses: actions/checkout@<sha> # v7.0.1`. Never a tag or a branch.
- Pin every container image by digest and keep the tag for readability: `FROM node:26-alpine@sha256:…`, `image: redis:8.10.2-alpine@sha256:…`, `docker://…@sha256:…`. Resolve a digest with `docker buildx imagetools inspect <ref> --format '{{.Manifest.Digest}}'`.
- `npm run pins:check` (or `make pincheck`) runs `tools/check-pins.mjs`, which enforces both, in `make check` and in CI. Fix the reference; do not edit the check or exempt a file.
- Dependabot moves the pins (`.github/dependabot.yml`). A new directory with a Dockerfile or a compose file goes under `docker` or `docker-compose` there, or its pin never moves. Never unpin to get updates.
- A new workflow declares `permissions:` per job, `contents: read` unless a step needs more, and checks out with `persist-credentials: false`.
- Never disable, skip, narrow or loosen a security workflow (CodeQL, Scorecard, dependency review, license check, pin check) to make CI pass. Report the failure instead.
- Secrets never enter the repository, a prompt, or a log line. Tokens are fine-grained and read-only.
