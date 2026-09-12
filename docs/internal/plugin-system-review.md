# Review: `new-plugin-system` vs `main`

Reviewed: `68a0e9fe` (`feat: new plugin system`) against `main`.
Scope: 155 files, +2904 / −4568. Largest packages: `http`, `std`, `kafka`, `view`.
Date: 2026-09-12.

This is a code review of the branch, not a design doc. Line numbers are HEAD.

## Verdict

The direction is right and the HTTP plugin rewrite is coherent: one Fastify plugin type, one registration loop, install order instead of stages, configuration handed in by the application rather than seeded by the feature.

Do not merge until the app-level plugin factory vs `container.init()` contract is fixed. After that, pick one merge rule for fluent methods vs `withConfig` and make every package match it. Several comments and agent docs still describe the API this branch deleted.

Security review found no medium-or-higher issues on the auth gate, bootstrap order, or secret handling.

## What changed

### Old model (gone)

- Features had a declare/configure split and registered **config slices** into `ConfigDefinition`.
- HTTP start-up wiring went through `ServerExtension` / bands / `kExtensionStage`.
- `.extend(feature, configure)` took the callback as a second argument.
- CORS, compress, HTML, multipart were features with builders.
- `ctx.config` was callable with a feature key.

### New model

A feature is one object with two symbol keys (`kFeatureName`, `kBootstrap`). `FeatureBuilder` runs the application's configure callback, then `bootstrap`. Configuration reaches a feature only because that callback wired it (`withConfig`, or a scalar copied out of the handle). Plugins are ordinary Fastify plugins (`HTTPPlugin`) contributed with `registerPlugin(kit, plugin)`.

`.extend` on the web builder takes a **feature object or a plugin factory**, discriminated by `typeof`. Both land in one list, so they register in written order. Features dedupe on `kFeatureName`; plugin factories never dedupe.

CORS, compress, HTML, and multipart are now plugins, not features:

```ts
.extend(c => corsPlugin(c.app.cors.options))
.extend(() => multipartPlugin())
```

`liveFold` in `@caffeinejs/std/config` is the new helper for a stable options object whose fields refold on refresh. Server, health, and shutdown use it. Kafka, view, static, and OpenAPI snapshot at bootstrap.

Petstore (`examples/03-petstore/src/app.ts`) already uses the new call shapes.

## Findings

### High

#### 1. App-level plugin factories run before `container.init()`

`HTTPPluginFeature` invokes the factory from `[kBootstrap]`:

```ts
async [kBootstrap](kit: BootstrapKit<C>): Promise<void> {
  registerPlugin(kit, await this.#factory(kit.config, kit.container))
}
```

`Application.ready()` runs every `[kBootstrap]`, **then** `container.init()`, **then** `setup()`. `CaffeineIoC.get()` / `getOptional()` / `getMany()` throw `ErrInvalidContainerState` (`Cannot resolve: container has not been initialized — call init() first`) before init.

The public example in `http/plugin.ts` therefore throws at `ready()`:

```ts
.extend((c, container) => rateLimitPlugin(container.get(Redis), c.app.limits))
```

The plugin-body example a few lines above is the working one: resolve inside the Fastify plugin, which receives `{ container }` after init.

Scoped factories (`router.extend`, `@Use`) run in `WebApplication.#registerScopedPlugins()`, during `setup()`, **after** init. They can `container.get`. App-level factories cannot. `http/AGENTS.md` says the opposite: scoped factories “see exactly what a factory passed to `.extend(...)` sees.” `@Use` TSDoc says the same.

`bind()`, `has()`, and `wrap()` still work in an app-level factory. Only resolution is illegal. There is no test that an app-level factory resolves a binding.

**Fix:** either (a) invoke app-level factories in `setup()` after init, keeping `registerPlugin` itself in bootstrap only for features that already hold a plugin, or (b) document that the factory must not resolve and delete the `container.get` example. (a) is what the docs already claim. If you delay the factory, keep the _registration slot_ stamped with the feature’s install index so an `await` still cannot reorder it relative to `.authentication(...)`.

### Medium

#### 2. Two merge rules, both tested, both documented as “the” rule

`CONVENTIONS.md` (this branch) is unambiguous: a fluent method is the last word; `withConfig` fills keys the code did not name.

| Package                           | Wired `withConfig` + fluent | Evidence                                                                                                                                  |
| --------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| server, health, shutdown, caching | fluent wins                 | `this.#port ?? this.#config?.port`; `http/server/_tests/server_config.test.ts` (“A fluent method is the last word”)                       |
| OpenAPI                           | fluent wins in code         | `foldConfigured` keeps a setter that differs from defaults. `withConfig` TSDoc says the opposite: “Applied **over** what the builder set” |
| kafka                             | config wins                 | `#resolve` uses `this.#config?.brokers ?? this.#brokers`; `kafka/kafka_config.test.ts` (“a builder method is a default, not a setting”)   |
| view                              | config wins                 | `ViewEngineBuilder.build` spreads config **over** code; `view/_tests/config.test.ts` expects env root to beat `.root(templatesRoot)`      |
| messaging                         | config wins                 | `bindingsOf` does `{ ...options, ...configured?.[binding] }`                                                                              |
| auth                              | config wins                 | `applyScheme` after the `addX` callback; TSDoc: a secret in code is a default the environment can redirect                                |
| static                            | split                       | `config.mounts` **replaces** `.serve()` (`static/builder.ts` `#resolve`); SPA merges `{ ...config.spa, ...#spa }` so fluent wins          |

Auth overlaying secrets is a reasonable exception. Kafka, view, and messaging are not documented as exceptions; their class comments even say “What a fluent method sets is final” and then `withConfig` says the opposite. Static’s mount-replace rule is an array exception that CONVENTIONS never names.

`std/config/README.md` still opens with the old rule (“the binary carries defaults, the deployment overrides them”) and a CODE band for `s.port(3000)`, then later restates the new fluent-wins rule. Readers will pick whichever paragraph they hit first.

**Fix:** one rule in CONVENTIONS. Implement it everywhere, or name the exceptions (auth secrets, maybe kafka brokers, static mount arrays) in CONVENTIONS and in those packages’ TSDoc. Do not leave both rules tested as regressions.

#### 3. Constructor comments claim env vars work without `withConfig`. Tests prove they do not.

`WebApplicationBuilder` constructor:

- `SERVER__PORT` “has to work on an application that never calls `.server()`.”
- `HEALTH__ENABLED=true` “has to switch the probes on without a code change.”
- `SHUTDOWN__DRAIN_DELAY` “has to work on one that never calls `.shutdown()`.”

`http/server/_tests/server_config.test.ts` (“leaves the server on its defaults when nothing pointed it at the block”) is the contract this branch actually shipped: declaring `server` in the schema is not enough; `.server((s, c) => s.withConfig(c.server))` is the instruction. Health’s `HEALTH__ENABLED=false` test also goes through `withConfig`.

Same stale line on `ApplicationBuilder` for `SHUTDOWN__DRAIN_DELAY`, and on `createWebApplication().shutdown()`: “`s.drainDelay('5s')` is a **default** that `SHUTDOWN__DRAIN_DELAY` or the config tree can still redirect.” `ShutdownBuilder` itself implements fluent-wins.

This is how someone will misconfigure production.

#### 4. “Never deduplicated” collides with Fastify plugin names

Plugin factories are intentionally not deduped (`http/_tests/plugins.test.ts`). First-party plugins wrap with a fixed `fastify-plugin` name (`cors`, `compress`, `html`, `multipart`, `view`, `static`, `openapi`, `caffeine-caching`, `caffeine-authentication`, …). Two `.extend(() => corsPlugin())` calls will throw Fastify’s duplicate-plugin error, not register twice.

That is a new failure mode: the old feature path refused the second install with `ErrFeatureAlreadyInstalled` before Fastify saw it.

#### 5. Stale public call shapes

These still describe APIs this branch removed:

| Location                                                      | Says                                                                          | Actual                                                                  |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `http/application_builder.ts` (`createWebApplication` JSDoc)  | `.extend(feature, configure)`                                                 | configure is an argument to the feature factory                         |
| `std/application_builder.ts` (`createApplication` JSDoc)      | same                                                                          | same                                                                    |
| `std/application_builder.ts` `config()` TSDoc                 | “a feature's `.config(c => c.app.thing)` selector”                            | `withConfig(c.app.thing)` in the feature callback                       |
| `kafka/AGENTS.md`                                             | `.extend(kafka(), k => k.brokers(...))`                                       | `.extend(kafka(k => k.brokers(...)))`                                   |
| `std/config/README.md` example                                | `.server(s => s.config(c => c.server))`                                       | `.server((s, c) => s.withConfig(c.server))`                             |
| `http/context.ts` `config` TSDoc                              | “Calling it reads a feature's own configuration — `ctx.config(kHTMLOptions)`” | `config` is a getter; `ctx.config` is not callable                      |
| `std/config/selector_path.ts`                                 | `s.config(c => c.app.server)`                                                 | that selector API is gone; `selectorPath` is only used by its own tests |
| `cors/config.ts`, `compress/config.ts`, `multipart/config.ts` | “the CORS feature's slice”, `c.config(x => x.app.cors)`                       | these packages are plugins; the app reads the node in the factory       |
| `openapi/builder.ts` `withConfig`                             | config applied over code                                                      | `foldConfigured` keeps fluent when it differs from defaults             |
| `static/_tests/config.test.ts` file comment                   | `s.config(c => c.static)`                                                     | leftover                                                                |

`kafka/plugin.ts`, `ai/docs/kafka.md`, and `ai/skills/caffeine-kafka-listener/SKILL.md` use the new `.extend(kafka('orders', k => …))` form and are fine.

### Low

#### 6. Config subsystem still carries the slice machine

`std/config/feature.ts`, `feature_key.ts`, and `option_bag.ts` were deleted, and `std/config/_tests/feature.test.ts` (603 lines) plus `feature_slice.test.ts` (369 lines) went with them. What remains:

- `ConfigDefinition.slices`, `.slice()`, `.codeValues` (CODE band), comments about `declare()` / “every feature has declared.”
- `publishSlices` / `notifySlices` still run on bootstrap. The only in-tree `slice()` caller for a real app is the framework `caffeine` block in `Application.ready()`.
- `std/config/README.md` package layout still lists `feature.ts`, `feature_key.ts`, `option_bag.ts`, and a `FeatureConfigKey` type.
- `kConfigDefinition` TSDoc: “Features resolve it to register a slice.”

This is leftover, not a runtime bug, but it will spawn new slice-based features from anyone reading `definition.ts` instead of CONVENTIONS.

#### 7. `liveFold` coverage is thin for the way health uses it

`std/config/_tests/live_fold.test.ts` covers fold-once, refold, enumerate/spread/JSON, and identity of merged-in objects. Health binds `HealthOwnedPaths` with `new HealthOwnedPaths(options.paths)` — that reads `.paths` once at bootstrap and snapshots the route list, which matches the comment that probe routes do not move. `healthProbesPlugin` also reads `options.enabled` once, at Fastify registration, so a refresh cannot mount or unmount probes. Budgets on the same object _do_ follow a refresh (tested). Worth one sentence on `HealthBuilder` so nobody assumes `enabled` is live.

The proxy implements `get`, `ownKeys`, `getOwnPropertyDescriptor`, and `has`. There is no `set` trap. `options.port = 1` writes onto the empty target and never reaches the folded object. Server, health, and shutdown bind that proxy under a container key. Silent wrong mutation if a collaborator treats the bound options as a plain record.

#### 8. `HTTPPluginFeature` names are a process-wide counter

`let counter = 0` then `` `plugin:${++counter}` ``. Unique enough for dedup (plugins are not deduped anyway). Harmless, slightly surprising in diagnostics across many apps in one process.

#### 9. `.extend(fn)` will swallow a constructor

Web `.extend` treats any function as an `HTTPPluginFactory`. Passing a class (or a leftover `feature()`-style factory) installs an `HTTPPluginFeature` instead of a feature. Failure is at `ready()`, as a Fastify plugin type error, not `ErrFeatureAlreadyInstalled`.

#### 10. Configure timing is not one rule

Server, health, shutdown, and auth queue callbacks with `kAddConfigurer` and run them at bootstrap, so the callback can read `c`. Guards, authorization, and constraints still run their configure function **immediately** on the builder method. That matches “nothing to read from the tree,” but an author who writes `.guards((g, c) => …)` expecting the same `(builder, config)` shape as `.server` will not get it. Auth configure also moved from the `.authentication()` call to bootstrap — side effects that assumed immediate configure break; using `c` in the callback now works.

## Breaking changes for application authors

Expect every existing app to change. The important ones:

1. `.extend(feature, configure)` → `.extend(feature(configure))`. Named kafka/messaging: `.extend(kafka('orders', k => …))`.
2. CORS / compress / HTML / multipart: no builder. `.extend(c => corsPlugin(c.app.cors.options))` (or `() => corsPlugin()` with literals).
3. Features do not seed the config tree. Env vars such as `SERVER__PORT` reach the server only after `.server((s, c) => s.withConfig(c.server))` and after the application schema includes `serverConfigSchema` (or equivalent). Same pattern for health, shutdown, kafka, view, static, OpenAPI, caching `statusHeader`.
4. `ctx.config` is the application snapshot, not a feature-key lookup. Packages bind options (`kServerOptions`, …) or decorate Fastify (`htmlPlugin`).
5. Router / `@Use` take plugin factories only, not features. A scoped CORS install is `router.extend(() => corsPlugin({ origin: '…' }))`, not `router.extend(cors('pets'), cfg)`.
6. Duplicate `.extend` of the same **feature** still throws `ErrFeatureAlreadyInstalled`. Duplicate **plugin** factories do not, until Fastify’s name check fires for wrapped first-party plugins.
7. View engines are nested: `v.engine(e => e.engine({ handlebars }).root(...))` instead of `v.engine({ handlebars }).root(...)`.
8. Configure mistakes surface at `ready()`, not at `.extend()` time. Features cannot contribute config bands before resolve.

## Tests

Strong where the new contracts were rewritten on purpose:

- Plugin order, feature/plugin interleaving, scoped router/controller plugins, duplicate plugin factories: `http/_tests/plugins.test.ts`.
- Auth gate still sits at the `.authentication(...)` write position: `http/security/authentication_gate_order.test.ts`.
- Server fluent-wins, unwired block ignored, refresh does not move the bound socket: `http/server/_tests/server_config.test.ts`.
- Health liveFold identity across refresh: `http/health/health_builder.test.ts`.
- Kafka config-wins (intentional, and in conflict with CONVENTIONS): `kafka/kafka_config.test.ts`.
- `ctx.config` snapshot across mid-request refresh: `http/_tests/context_config.test.ts`.
- Feature install / no builder methods / dedup: `std/plugin_extend.test.ts`, `http/plugin.test.ts`.
- OpenAPI tests were rewritten so env fills keys code did not name (`openapi/_tests/config.test.ts`).

Gaps:

- No test that `.extend((c, container) => { container.get(...) })` either works or fails with a useful error (finding 1).
- No test that a second `corsPlugin` / `htmlPlugin` fails with a Caffeine error rather than Fastify’s (finding 4).
- Kafka, view, messaging, auth never assert fluent-wins, so CONVENTIONS can drift forever.
- Caching never asserts `statusHeader('X-From-Code').withConfig(c.cache)` against an env override (code does fluent-wins; untested).
- HTML lost the “env / live node drives `autoDoctype`” tests; new tests pass a plain object into `htmlPlugin`, not `c.app.html`.
- Deleted slice tests were not replaced with a single “feature does not register a slice / CODE band is unused by builders” contract test. Per-package tests imply it; nothing pins the negative.

## Security

Reviewed the auth gate, plugin order, scoped plugins, and config overlay.

- Gate still comes only from `AuthenticationBuilder.bootstrap` via `registerPlugin(kit, authenticationPlugin())`. Position is `.authentication(...)` among `.extend(...)` calls.
- Protected routes without authentication still fail in the adapter (`assertAuthenticationConfigured`), independent of the gate plugin.
- Auth still applies configuration **over** in-code scheme options when `withConfig` is wired, so env secrets beat hardcoded ones. That is the one place config-wins is the safer default.
- Scoped plugins run after `container.init()`. Same trust as application code that mounts the router.
- CORS/compress options from a `Record` in the config tree are deployer-controlled, as before.
- Auth diagnostics gained precise `SCHEME_SCHEMAS` splicing so `$t.Secret` redaction applies. Improvement.

No medium-or-higher security issue in this diff.

## What held

- Framework brackets are unchanged: error handling and HTTP core first, not-found last, everything else in `.extend` order (`WebApplication.configurers()`).
- Plugin order is the feature’s index in that list, not the moment `registerPlugin` ran, so an `await` in bootstrap cannot jump the queue (`HTTPPlugins.registrarFor`).
- Built-in resolved options are container bindings (`kServerOptions`, `kHealthOptions`, `kStaticOptions`, `kOpenAPIOptions`), not feature config keys.
- Health is still probes-only; shutdown is a separate feature registered on both `createApplication` and `createWebApplication`.
- `beforeDrain()` now no-ops when `ready()` never succeeded, so a failed start does not throw a second time while closing.
- Petstore compiles the new authoring style: `view(...)`, `staticFiles(...)`, `openapi(...)`, `() => multipartPlugin()`, `.server((s, c) => s.withConfig(c.server))`. Its schema still restates server fields instead of importing `serverConfigSchema` (defaults `9999` vs framework `0`) — pre-existing style, not introduced here.

## Suggested fix order

1. Make app-level `HTTPPluginFactory` able to `container.get`, or stop documenting that it can. Add a test that fails today.
2. Align kafka / view / messaging (and the shutdown JSDoc) with CONVENTIONS, **or** write the exceptions into CONVENTIONS. Do not ship both.
3. Delete or rewrite the `SERVER__PORT` / `HEALTH__ENABLED` / `SHUTDOWN__DRAIN_DELAY` comments and the `.extend(feature, configure)` JSDoc.
4. Fix `kafka/AGENTS.md`, `http/context.ts` `config` TSDoc, `std/config/README.md` (opening rule, mermaid still publishing slices, example `.server(s => s.config(...))`, layout table naming deleted files), cors/compress/multipart `config.ts` (`c.config(...)` / “feature slice”), and OpenAPI `withConfig` TSDoc.
5. Decide whether a second named first-party plugin should fail in `HTTPPlugins.register` with `ErrFeatureAlreadyInstalled`-quality text, or keep Fastify’s error and document it.
6. Either retire `ConfigDefinition.slice` / `codeValues` from the feature path or stop talking about them as if features still use them.
7. Restore an HTML live-node / refresh test, and add caching `statusHeader` + `withConfig` together.
