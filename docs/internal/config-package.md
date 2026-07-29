# `@caffeinejs/config` — package overview

## What it does

Multi-source configuration system. Load config from N sources (env vars, files, Spring Cloud Config Server, inline objects), merge them by priority, validate the result against a schema, and expose a typed live accessor. Supports IoC integration and live refresh.

The design is deliberately layered: each stage is a pure function or a single-responsibility class with no cross-cutting concerns. You can use just the engine without the IoC module, just the materializer without the accessor, or just the schema validation without any providers.

---

## Core data model (`types.ts`)

Every value in the system flows through these six types. Nothing else is invented mid-pipeline.

### `ConfigPrimitive`

```ts
type ConfigPrimitive = string | number | boolean | null
```

The leaf value universe. Anything that can appear at the end of a config key. Excludes `undefined` — a missing key is represented by absence from the `Map`, not by a `null`/`undefined` value.

### `ConfigValue`

```ts
type ConfigValue = ConfigPrimitive | ConfigValue[] | { [k: string]: ConfigValue }
```

Recursive union. A config value is either a primitive, an array of config values, or a mapping of string keys to config values. This mirrors the shape of JSON/YAML documents exactly. Typed recursively so that deeply nested structures are expressed without `unknown` or `any`.

### `ConfigEntry`

```ts
interface ConfigEntry {
  key: string       // the flat dot-path key, e.g. "http.server.port"
  value: ConfigValue
  origin: string    // which provider wrote this, e.g. "env:PORT", "scc:application.yml"
  profile?: string  // Spring profile active when this entry was loaded (SCC only)
  label?: string    // Git branch/tag/commit from SCC (SCC only)
}
```

The atomic unit of configuration. Every key in the system is stored as a `ConfigEntry` rather than a raw value so that the origin is always traceable. `profile` and `label` are optional because only `SpringCloudConfigProvider` populates them — file-based and env-based providers don't have that concept.

### `PropertySource`

```ts
interface PropertySource {
  name: string
  precedence: number
  entries: Map<string, ConfigEntry>
}
```

The unit of output from a provider. One `PropertySource` maps to one logical source — for example, one YAML file, or one SCC `propertySources[]` entry. The `precedence` number controls priority during merge: **lower number = higher priority**. The `entries` map is keyed by flat dot-path (`"http.port"`, not `{ http: { port: ... } }`). Providers return `PropertySource[]` — plural — because a single load call may produce multiple sources (e.g. SCC returns one `PropertySource` per remote file, plus an optional metadata source).

### `ResolutionContext`

```ts
interface ResolutionContext {
  app: string                           // logical app name ("my-service")
  profiles: string[]                    // active profiles (["default", "prod"])
  label?: string                        // SCC label (git branch/tag)
  env?: Record<string, string | undefined>  // injectable env override (for tests)
  signal?: AbortSignal                  // cancellation propagated into HTTP providers
}
```

The input to every provider's `load()` call. Passed unchanged through the engine to every provider so each one can interpret it according to its own semantics. `env` makes `EnvProvider` deterministic in tests without monkey-patching `process.env`. `signal` is propagated through to `SpringCloudConfigProvider`'s HTTP calls so the caller can cancel a slow config load.

### `ConfigSnapshot`

```ts
interface ConfigSnapshot {
  sources: PropertySource[]           // all sources, sorted by precedence
  values: Map<string, ConfigEntry>    // merged flat view: first writer of each key wins
}
```

The engine's output. Two views of the same data: `sources` preserves the full per-provider breakdown (useful for diagnostics — you can see every value each provider contributed), while `values` is the already-merged flat map used for materialisation. The merged map applies first-write-wins: if two providers define `http.port`, the one with lower precedence wins and the other is silently shadowed.

### `ConfigProvider`

```ts
interface ConfigProvider {
  readonly id: string
  load(ctx: ResolutionContext): Promise<PropertySource[]>
  watch?(ctx: ResolutionContext, onChange: () => void): Promise<() => Promise<void>>
  dispose?(): void | Promise<void>
}
```

The interface every provider implements. `load` is the only required method. `watch` is an optional extension point for providers that can signal config changes without polling (e.g. a file watcher) — it returns a teardown function. `dispose` is called by `ConfigShard` when the container shuts down, giving providers a chance to close connections or file handles. The optional methods are designed for future capabilities; no built-in provider implements them yet beyond `dispose`.

### `SchemaIssue`

```ts
interface SchemaIssue {
  path: string     // dot-path to the invalid field, e.g. "http.port"
  message: string  // human-readable problem description
  code?: string    // optional machine-readable code (Zod uses "too_small", etc.)
}
```

Normalised validation failure. Because `ConfigSchema<T>` is schema-library-agnostic, the adapter layer (e.g. `schema_from_zod.ts`) translates library-specific error shapes into `SchemaIssue[]` so that `ErrConfigValidation` always carries a consistent structure regardless of which library is used.

---

## Pipeline

```
ResolutionContext
      │
      ▼
  ConfigEngine.resolve()
      │  calls load(ctx) on every provider in parallel (Promise.all)
      │  flattens all PropertySource[] arrays into one list
      │  sorts by precedence asc, then name asc (stable tie-breaking)
      │  merges: first writer of each key wins → ConfigSnapshot.values
      ▼
  ConfigSnapshot
      │
      ▼
  materialize()
      │  iterates ConfigSnapshot.values
      │  splits each dot-path key, respecting \. escape for literal dots
      │  writes value into a nested plain object via setByPath()
      ▼
  Record<string, unknown>   (nested plain object)
      │
      ▼
  validateConfig()
      │  calls schema.parse(nested object)
      │  normalises any thrown error into ErrConfigValidation
      ▼
  T   (validated, typed config)
      │
      ▼
  createLiveAccessors(() => T)
      │  wraps a closure over T in an ES6 Proxy
      ▼
  ConfigHandle<T>   (typed, read-only, live)
```

The key design decision: **everything upstream of `createLiveAccessors` is stateless and side-effect-free**. The engine, materializer, and validator are pure functions over their inputs. This makes each stage independently testable and lets refresh simply re-run the whole pipeline and swap the `T` in place.

---

## Engine (`config_engine.ts`)

`ConfigEngine` is thin on purpose. It does three things and nothing else:

1. **Parallel load** — calls every provider's `load(ctx)` concurrently via `Promise.all`. Providers don't share state and don't depend on each other's output, so there's no reason to sequence them.

2. **Error handling** — if `failFast !== false` (default), any provider failure immediately rejects the whole `resolve()` call. If the thrown error is already an `ErrConfigProvider`, it passes through; otherwise it's wrapped in one. If `failFast: false`, a failing provider is treated as returning an empty source list — config loads with whatever the other providers contributed.

3. **Merge** — sorts all `PropertySource` objects by `precedence` ascending (lower number = earlier in list = higher priority), then iterates each source's entries and writes into the result `Map` only if the key hasn't been written yet (first-write-wins).

The engine never touches the file system, environment, or network — those are all provider concerns.

---

## Materializer (`materializer.ts`)

Converts the flat `Map<string, ConfigEntry>` from a `ConfigSnapshot` into a nested plain object that a schema library can validate.

**`materialize(snapshot)`** iterates `snapshot.values` and calls `setByPath(result, splitKey(key), entry.value)` for each entry.

**`splitKey(key)`** splits on `.` but respects `\.` as an escape sequence for a literal dot in a key segment. So `"server.host"` → `["server", "host"]` and `"my\.key.nested"` → `["my.key", "nested"]`.

**`setByPath(obj, parts, value)`** walks the parts array, creating intermediate objects as needed. If a path segment already exists as a non-object (a primitive or array), it is overwritten with a new empty object — this handles the edge case where a more specific key `a.b.c` is set before a less specific one would try to set `a.b` to a scalar.

**`readByPath(obj, path)`** is the reverse — used by `ConfigDiagnostics.valueAt()` to read a value back out of the validated object by dot-path.

---

## Providers (`providers/`)

| Provider | Source | Precedence default | Notes |
|---|---|---|---|
| `EnvProvider` | `process.env` (or `ctx.env`) | 10 | Strips prefix, transforms key, coerces to bool/number |
| `FileProvider` | Filesystem (`.json`, `.yaml` via `yaml_parser.ts`) | 80 | Extensible via `registerParser()` |
| `InlineProvider` | In-memory object | 100 | Used in tests and dynamic scenarios |
| `SpringCloudConfigProvider` | Spring Cloud Config Server HTTP API | 50 | Retry + timeout + auth (Bearer/Basic/`beforeRequest` hook) |

**Lower precedence number = higher priority.** Sources are sorted ascending by precedence, then merged with first-write-wins — so `EnvProvider` (10) overrides SCC (50) which overrides `FileProvider` (80). This ordering matches the Spring Boot convention: environment variables always win over remote config which wins over file-based defaults.

### `EnvProvider`

Reads from `ctx.env ?? process.env`. For each variable:
1. If `prefix` is set, skips variables that don't start with it and strips the prefix from those that do.
2. Calls `transformKey` (default: `key.toLowerCase().split('__').join('.')`) to convert `APP__HTTP__PORT` → `app.http.port`.
3. Coerces string values: `"true"/"false"/"1"/"0"/"yes"/"no"/"on"/"off"` → `boolean`; numeric strings → `number`; everything else stays a `string`.

`ctx.env` injection is the key testing affordance — tests pass `{ DATABASE_URL: 'postgres://test' }` instead of touching `process.env`.

### `FileProvider`

Reads a file from disk, selects a parser by extension, calls `parser.parse(text)`, then flattens the resulting object via `_flatten.ts`. JSON is built in. YAML is available by importing `providers/yaml_parser.ts` as a side effect, which calls `registerParser()` on load.

The parser registry (`parsers: Map<string, FormatParser>`) is module-level, so `registerParser()` is a global registration — once called, any `FileProvider` instance picks up the new format.

### `InlineProvider`

Takes a plain object in its constructor, flattens it via `_flatten.ts` on each `load()` call. No I/O. Used in `ConfigModule` tests and wherever config needs to be injected programmatically. The `precedence` and `id` are constructor parameters so multiple `InlineProvider` instances can be ordered relative to each other.

### `SpringCloudConfigProvider`

The most complex provider. Fetches `/{app}/{profiles}[/{label}]` from a Spring Cloud Config Server.

**URL construction:** each profile name is `encodeURIComponent`-encoded individually, then joined with a literal comma (commas are valid unencoded in RFC 3986 path segments and SCC's `@RequestMapping` splits on literal commas, not `%2C`).

**Retry loop:** iterates `baseURLs` in order, then retries within each URL up to `retries` times (default 3). 5xx → retriable with exponential backoff + jitter (`min(100 * 2^attempt + random(50), 2000)`ms). 4xx → non-retriable, thrown immediately (a config server returning 401 or 404 won't heal with retries).

**Timeout:** a fresh `AbortController` per attempt gates the HTTP call. The caller's `ctx.signal` is combined via `AbortSignal.any([signal, controller.signal])` — whichever fires first wins. This means a caller can cancel the whole load without waiting for the timeout.

**Auth:** `beforeRequest` hook fires before each attempt with `(url, init)` and returns the modified `RequestInit`. This is the primary extension point for dynamic credentials (token refresh, AWS SigV4, etc.). Static credentials (`authToken`, `basicAuth`) are handled by `#buildHeaders()` which runs before the hook.

**Response mapping:** SCC responds with a `propertySources[]` array where index 0 is highest priority. The provider maps each to a `PropertySource` with `precedence = options.precedence + i`, so SCC's own ordering is preserved within the provider's slot. An optional metadata source at `precedence - 1` carries `config.client.version` and `config.client.state` from the SCC response.

**Optional:** when `optional: true`, a failed load returns `[]` silently. When `optional: false` (default) and all baseURLs are exhausted, throws `ErrConfigProvider(this.id, lastError)`.

### `_flatten.ts` (private)

Shared recursive helper: walks a nested object depth-first, writing each leaf as a dot-keyed `ConfigEntry` into the output `Map`. Arrays are written as leaf values (not flattened into `arr.0`, `arr.1`). Marked private (underscore prefix) — not importable outside `providers/`.

---

## Schema validation (`schema.ts`)

`ConfigSchema<T>` is a minimal interface — just `{ id, parse(input): T }`. The engine doesn't care whether you use Zod, Valibot, or hand-rolled validation.

`validateConfig()` calls `schema.parse()` and normalises thrown errors into `ErrConfigValidation` with `SchemaIssue[]`. If the schema already threw `ErrConfigValidation`, it passes through unchanged — so nested validation calls don't double-wrap.

`adapters/schema_from_zod.ts` provides `schemaFromZod(id, zodSchema)` — bridges Zod's `safeParse` API to `ConfigSchema<T>` and maps Zod's `issues[].path` (which is `Array<string | number>`) to dot-path strings. The adapter uses `safeParse` rather than `parse` to avoid Zod throwing its own `ZodError` before the normalisation layer can intercept it.

---

## Live accessor and why ES6 Proxy (`config_accessor.ts`)

### The problem

After bootstrap, the validated config `T` is a plain frozen object. You could inject it directly into beans. But then a config refresh — which produces a new `T` — would not be visible to beans that already hold a reference to the old object. Every bean would need to be re-resolved after every refresh, which defeats the point of refresh.

### Why not a getter-based wrapper?

A hand-written wrapper class (`class Config { get httpPort() { return this._inner.http.port } }`) would require knowing the schema's shape at code-generation time, or using runtime metaprogramming against the schema. It also couples the accessor type to the schema library.

### Why Proxy

An ES6 `Proxy` intercepts property access at runtime on any object shape, without knowing the shape in advance. `buildNode(source: () => T)` creates a `Proxy` over an empty object `{}`. The target object is irrelevant — all reads, writes, key enumerations, and `in` checks are intercepted and delegated to the `source` closure:

- **`get` trap** — calls `source()` on every access to get the current value of `T`, then reads the requested property from it. If the value is a nested object, it returns a new `Proxy` (`buildNode(() => source()[prop])`) rather than the raw object — this chains the liveness guarantee through arbitrarily deep nesting. If the value is an array, it returns a frozen shallow copy so callers cannot mutate it.
- **`set` trap** — always throws `TypeError`. Config is read-only after bootstrap.
- **`ownKeys` trap** — delegates to `Object.keys(source())` so `Object.keys(config)`, spread, and `for...in` all work correctly against the live shape.
- **`getOwnPropertyDescriptor` trap** — required alongside `ownKeys` for spread/enumeration to work in strict mode; returns `{ configurable: true, enumerable: true, writable: false }` for each key.
- **`has` trap** — delegates `prop in config` to `prop in source()`.

The liveness comes entirely from the `source` closure. `bootstrapConfig` binds it to a `const`, so `bootstrapConfig`'s handle never refreshes. `ConfigShard` binds it to `() => this.#validated`, where `#validated` is reassigned on each `[kSelfRefresh]()` call — so the same handle reflects the new config the moment refresh completes, without re-injecting anything.

### Trade-off: referential inequality

`handle.http !== handle.http` is always `true` — each `get` access to a nested object creates a new `Proxy` instance. Code that compares sub-objects by reference (React dependency arrays, `Object.is`-based change detection) will always see a change. This is the deliberate cost of liveness: caching the proxy would require invalidating the cache on refresh, which reintroduces the stale-reference problem. Keep reads at the leaf level, or destructure at call site rather than storing nested handles.

---

## Diagnostics (`config_diagnostics.ts`)

```ts
createConfigDiagnostics(validated: T, snapshot: ConfigSnapshot): ConfigDiagnostics
```

A thin façade over the snapshot, exposed alongside the `ConfigHandle<T>` after bootstrap:

- **`originOf(path)`** — looks up `snapshot.values.get(path)?.origin`. Returns strings like `"env:DATABASE_URL"`, `"file:/config/app.yaml"`, `"scc:application.yml"`. Returns `undefined` if the key is absent from the snapshot (e.g. it was set by the schema's default, not by any provider).
- **`valueAt(path)`** — calls `readByPath(validated, path)`. Reads the schema-validated, post-coercion value — not the raw provider value. Useful when a schema transform changes the type (e.g. parsing a string `"8080"` into a `number`).

`diagnostics.snapshot` is also exposed directly for deeper inspection — you can iterate `snapshot.sources` to see every `PropertySource` and which keys each provider contributed, even the ones that were shadowed during merge.

---

## Bootstrap (`bootstrap.ts`)

One-shot function for apps that don't use the IoC container:

```ts
const { config, validated, snapshot, diagnostics } = await bootstrapConfig({
  providers: [new EnvProvider({ prefix: 'APP_' }), new FileProvider('./config.yaml')],
  schema: mySchema,
  context: { app: 'my-service', profiles: ['default', 'prod'] },
  failFast: true,  // default
})
```

Wires the full pipeline in order: engine → materialise → validate → live accessor → diagnostics. Returns all four artifacts so callers can choose what to use.

`config` is a `ConfigHandle<T>` but its `source` closure captures `const validated` — it reads from the same object forever. This is intentional for `bootstrapConfig`: the function is a one-shot load, not a live-refresh setup. If you need the handle to reflect future refreshes, use `ConfigShard` (via `ConfigModule` in IoC mode, or directly).

The default `ResolutionContext` when `context` is omitted is `{ app: 'application', profiles: ['default'] }`, matching Spring Boot's defaults.

---

## IoC integration (`integration/`)

### `ConfigShard<T>`

The stateful wrapper that bridges bootstrap and refresh. Holds `#validated: T` and `#snapshot: ConfigSnapshot` as private mutable fields. Implements CaffeineJS's `SelfRefreshable` protocol via `[kSelfRefresh]()`:

```ts
async [kSelfRefresh](): Promise<void> {
  const result = await bootstrapConfig(this.#options)
  this.#validated = result.validated
  this.#snapshot = result.snapshot
}
```

The `handle` property is a `ConfigHandle<T>` whose source closure is `() => this.#validated`. After `[kSelfRefresh]()` updates `#validated`, every subsequent property access on the same handle object returns values from the new config — no re-injection needed.

`dispose()` calls `provider.dispose?.()` on every provider, allowing providers with persistent connections (e.g. a file watcher) to clean up.

### `ConfigModule<T>(options)`

A CaffeineJS `Module` factory function. Modules are async functions that receive a container and register bindings. `ConfigModule`:

1. Calls `ConfigShard.bootstrap(options)` during module execution (which happens at `container.init()` time).
2. Binds `options.token → shard.handle` so any bean can inject the live `ConfigHandle<T>` by token.
3. Binds an internal `shardKey → shard` scoped to `Scopes.REFRESH` and labelled `CONFIG_REFRESH_LABEL`. The `REFRESH` scope and label are what make CaffeineJS's refresher aware of this shard.

When `container.refresher.refresh(CONFIG_REFRESH_LABEL)` is called, CaffeineJS finds every binding labelled `CONFIG_REFRESH_LABEL`, calls `[kSelfRefresh]()` on each, then marks those bindings as stale. Multiple `ConfigModule` calls each create their own `ConfigShard`, so two config modules refresh independently and cannot interfere with each other.

The `CONFIG_REFRESH_LABEL` symbol is a `unique symbol` — it cannot be accidentally constructed by callers, preventing collision with unrelated refresh labels.

---

## Error hierarchy (`errors.ts`)

```
ErrConfig (base)
  ├── ErrMissingConfigKey     — key not in snapshot
  ├── ErrInvalidConfigType    — coercion failed (expected vs actual type)
  ├── ErrConfigValidation     — schema.parse() rejected (carries SchemaIssue[])
  ├── ErrConfigProvider       — a provider failed to load (carries cause)
  └── ErrConfigRefresh        — refresh cycle failed (carries cause)
```

All errors carry:
- `code: string` — machine-readable, e.g. `ERR_CONFIG_PROVIDER`
- `cause?: unknown` — the original error that triggered this one, following the ES2022 `Error.cause` convention
- `.name` — matches the class name exactly (`"ErrConfigProvider"`, not `"Error"`) so `instanceof` and `err.name` checks both work

The naming convention uses the `Err` prefix (Rust/Go style) rather than the JS `SomethingError` suffix — a deliberate divergence.

`ErrConfigProvider` wrapping rule: the engine wraps any raw error from `provider.load()` in `ErrConfigProvider`. If the provider already threw `ErrConfigProvider` (as `SpringCloudConfigProvider` does when `optional: false`), the engine detects this via `instanceof` and re-throws it unwrapped, preventing double-nesting.

---

## Public surface (`index.ts`)

Everything is exported except:
- `_flatten.ts` — private to `providers/`, never exported
- `ConfigShard` — internal implementation detail managed by `ConfigModule`; callers should never construct it directly
- `schemaFromZod` — not in `index.ts`; imported directly from `adapters/schema_from_zod.js` to keep the adapter optional and avoid a hard dependency on Zod in the main barrel
