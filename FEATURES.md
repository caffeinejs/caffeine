# Writing features and plugins

How to write a feature, a plugin factory, or a feature's configuration schema in **this** monorepo. Read it before that work; the rest of the conventions are in [`CONVENTIONS.md`](CONVENTIONS.md).

## Features and plugins

Two registration verbs, two kinds of thing:

- **`.install(feature)`** — on every `Application`. A feature is a container binder: deduplicated by `[kFeatureName]`, platform-agnostic, and order-free — every feature configures before the container initializes, so where an `.install(...)` sits in the chain does not matter. Feature factories are **PascalCase**: `Kafka()`, `Messaging()`, `DistributedLock()`, `TypeORM()`, `Health()`, `Authentication()`, `Authorization()`, `Guards()`.
- **`.with(factory)`** — on `WebApplication`, on a listener's builder for that listener alone, `.listener(name, l => l.with(factory))`, and on a router for that router alone, `router.with(factory)`. A factory produces a server plugin, or an `HTTPPlugin`, a plugin written against Caffeine alone whose `register(context)` runs in that slot; factories run at setup, after `container.init()`, and install in the order the `.with(...)` calls are written. Never deduplicated. Either kind of factory mounts routers and adds middleware where its `.with(...)` was written with `context.app`. Plugin factories are **camelCase**: `authentication()`, `healthProbes()`, `staticFiles()`, `openapi()`, `view()`, `HTTPCaching()`.

A capability that binds _and_ wires the server ships both halves under one name, cased apart: `.install(Authentication(configure))` binds the schemes and services, `.with(authentication())` registers the gate. A plugin that depends on a feature asks `context.hasFeature(name)` in its factory (or `instance.$hasFeature(name)` in its body) and throws `ErrFeatureNotInstalled` — loudly, at start-up. The feature alone stays a supported configuration, but where something needs the plugin the feature is not safe without, start-up refuses it: a protected route no gate covers fails with `ErrAuthenticationGateRequired`.

## Where a feature puts what it produces

Where a value goes depends on who reads it, not on what is convenient:

| The value is…                                         | Goes to                                | Read with                               |
| ----------------------------------------------------- | -------------------------------------- | --------------------------------------- |
| a setting a user tunes from the environment or a file | the application's configuration tree   | the configure kit's `config`            |
| a value the feature runs on                           | an ordinary field on the builder       | the builder reads its own field         |
| a setting code outside the feature must read          | a container binding, in `configure`    | `container.getOptional(key)`            |
| something user code injects                           | a container binding, in `configure`    | `container.get` / constructor injection |
| one of many providers a single consumer collects      | a container binding with `.extends()`  | `container.getManyOptional(Base)`       |
| a listener the feature ships                          | the application's listener list        | `listenersOf(kit).add(name, configure)` |
| start-up wiring the server runs                       | a plugin, from a factory               | `.with(factory)`, in its written slot   |
| routes or middleware a plugin adds                    | the server or router it registers on   | `context.app`, in its slot              |
| a plugin's own data                                   | the **closure** the plugin is built in | the captured value                      |
| a plugin's setting read per request                   | a Fastify decoration the plugin sets   | `request.server[kThing]`                |

Those are the only answers.

- No side channel between a feature and the configuration: a feature registers no slice, publishes no key, and adds no field to the resolved configuration object. A value the application needs once everything is up is either configuration, read out of the tree by the callback, or a binding.
- A fluent method is the last word: `s.drainDelay(5 * Second)` is what the feature runs on. Configuration reaches a feature only because the application's configure callback handed it over (`.shutdown((s, { config }) => s.config(config.app.shutdown))`). The more specific wins: a setter beats the block `config(...)` handed over.
- Exceptions, where `config(...)` overlays what the fluent methods set: authentication scheme options (a secret in the tree redirects one written in code); kafka (`brokers`, `clientId`, `groupId`, and every other key `config(...)` carries); messaging binding destinations (and the other binding options `config(...)` carries).
- The application declares its whole schema itself; a feature's own schema is internal to its package for now. A block with required, undefaulted fields and no source fails validation at `bootstrap()`.
- A feature nothing wired runs on its own defaults and its builder values alone.
- What a feature is configured from is a snapshot: `b.config(config.app.thing)` and `b.port(config.app.thing.port)` both hand over the values the application started with, and neither they nor a bound value are reached by a later reload. A feature that must act on a change subscribes with `store.onChange(...)` from the kit; code that must read the newest values injects the configuration's `liveConfigToken`, a `Provider`.
- A plugin closes over its own options. Do not route them through a container key it reads back at server setup; `instance.register(thingPlugin(options))` inside the factory's plugin is the whole act. State a feature binds for its plugin goes through the container (`OIDCRoutesRef` is the model), never through shared builder fields.
- The application's own server's construction and listen settings are not a feature: `.server(configure)` hands them to the adapter, which builds the server in `setup()` once the container has initialized. A listener is not a feature either: the application keeps a list of them, `.listener(name, l => l.server(configure))` or a feature's `listenersOf(kit).add(...)`, never a container binding, and the adapter builds each through the same `setup()`.
- A plugin reaches its parent context only when wrapped in `fastify-plugin`; unwrapped, its hooks and decorations stay inside it. Registered at the root by `.with(...)`, an fp-wrapped plugin covers every route; registered on a route group by `router.with(...)` or `@Use(...)`, it covers that group alone.
- Plugins install in the order of the `.with(...)` calls of the server they are registered on. There are no stages and nothing is sorted by kind; a plugin that must precede another is registered first. One slot finishes, including what its factory awaited and what its plugin registered without awaiting, before the next starts.
- Two framework head slots lead, ahead of everything `.with(...)` registers: error handling, then cookies (each server's cookie settings and its `Set-Cookie` writer). The default not-found handler is installed by the adapter after every plugin, and a plugin that set its own keeps it.

## A feature's configuration schema

Every feature a user can tune from the tree has one schema describing its options. The feature never imports it.

- **It satisfies the options.** What the schema decodes, read-only, is assignable to `Partial<Options>`, where `Options` is what the builder's `config(...)` takes (or what the plugin factory takes, for one with no builder). Only the data members are in it: a function, a class, an instance or a schema stays in code. The file asserts it at compile time: `type _Satisfies = SchemaSatisfies<KafkaConfig, InferConfig<typeof KafkaConfigSchema>>`.
- **The dependency points one way.** A schema imports the feature's option types. Nothing a package ships outside `_spectypes/` imports from it, and no barrel re-exports it; `test/spectypes.test.ts` fails otherwise.
- **The name is `<Feature>ConfigSchema`**, PascalCase under the acronym rules: `KafkaConfigSchema`, `OpenAPIConfigSchema`, `HTTPCachingConfigSchema`.
- **It lives in `_spectypes/` at the package root**, one file per schema (`http/_spectypes/health.ts`, `http/_spectypes/auth.ts`, …), with a barrel `index.ts`. A file may declare several top-level schemas to build the one it configures with, and exports only that one. It is internal, on purpose, until its public shape is settled: no `exports` subpath and no package barrel reaches it.
- **Its JSON Schema is generated into `_spec/`**, mirroring the file: `_spectypes/health.ts` becomes `_spec/health.gen.json`. `make spec` (after `npm run build`) writes it, it is committed, and `make check` fails when it is stale. Never edit it by hand; `tools/generate-spec.mjs` is a pipe of stages, so another output is one more stage.
- **Tests below the package root restate what they need.** The `_` privacy rule keeps them from importing `../_spectypes`, so they declare the block they configure inline; a test at the package root imports `./_spectypes/index.js`.
- **Nothing is defaulted in it.** The feature owns its defaults; a default in the schema would be a second place to change it.
- Every key is one an environment variable folds to (`test/config_keys.test.ts`), which is why an option spelled `cacheTTL` in code is `cacheTtl` in the schema.

## Writing a feature

A feature is one interface with three members, all symbol-keyed so none of it shows on a fluent surface:

```ts
export interface Feature<C = unknown> {
  get [kFeatureName](): string
  [kFeatureConfigure](kit: FeatureConfigureKit<C>): void | Promise<void>
  [kFeatureBootstrap]?(kit: BootstrapKit<C>): void | Promise<void>
}
```

- `[kFeatureName]` is the identity `.install` deduplicates on. A feature accepting an instance name folds it in (`kafka` vs `kafka:orders`). Built-in names (`shutdown`, `logger`, `error-handling`, `cookie`) enter the same set, so a colliding user feature is refused, and `hasFeature(name)` answers for them too.
- `[kFeatureConfigure]` runs after configuration has resolved and before the container initializes: `config` is readable and binding is open. `[kFeatureBootstrap]` is optional and runs after `container.init()`; look up bindings there. Its kit carries the application's logger.
- A feature never touches a server; adding a listener to the list is the one exception. There is no server hook on the contract: server wiring is a plugin factory's, registered with `.with(...)`. A feature whose plugin needs what it resolved binds it (`OIDCRoutesRef`), and the plugin reads it from the container.
- Most features extend `FeatureBuilder<C>` from `@caffeinejs/application`, which does one thing: it runs the application's configure callbacks against the builder, with the resolved configuration, immediately before `configure`. A subclass names itself, holds what its fluent methods set in ordinary fields, and binds in `configure`.
- The application's callback is `(builder, kit)`. The kit is the `FeatureConfigureKit` the feature's own `configure` receives: `config`, `store`, and `container.bind(...)`, but no `container.get(...)` yet. A plugin's builder callback is `HTTPPluginConfigurer` and is handed the `HTTPSetupContext`, where the container resolves and binding is closed.
- A start-up callback added to an application, a feature or a plugin takes the kit of the phase it runs in: `FeatureConfigureKit` before the container initializes, `BootstrapKit` after it, `HTTPSetupContext` in a plugin factory. It defines no context type of its own. A per-request callback takes the request's context instead, and the signatures that predate this rule (`bootstrap(configure)`, `Authorization(fn)`, `Guards(fn)`) stay as they are.
- Output that only decorates start-up, such as a banner or a report, never fails it: what goes wrong is a warning on the application's logger.

```ts
export class ThingBuilder<C = unknown> extends FeatureBuilder<C> {
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
}
```

- The package exports a PascalCase factory function, generic over the application configuration type:

```ts
export function Thing<C = unknown>(configure?: FeatureConfigurer<ThingBuilder<C>, C>): Feature<C> {
  return new ThingBuilder<C>(configure as never)
}
```

- A feature taking an instance name overloads on it and folds it into `[kFeatureName]`:

```ts
export function Thing<C = unknown>(configure?: FeatureConfigurer<ThingBuilder<C>, C>): Feature<C>
export function Thing<C = unknown>(instance: string, configure?: FeatureConfigurer<ThingBuilder<C>, C>): Feature<C>
```

- The plugin half, when the capability has one, is a separate camelCase factory in the same package: `HTTPPluginFactory<C>` built from an `HTTPPluginConfigurer` callback, reading what the feature bound out of the container and refusing a missing feature with `ErrFeatureNotInstalled` (`healthProbes()` and `authentication()` are the models). One that needs nothing from Fastify returns an `HTTPPlugin` instead, its factory typed `AdapterExtensionFactory<HTTPPlugin, C>`, and mounts routers and adds middleware from `register(context)` with `context.app`. A plain `HTTPPlugin` is written for no adapter; one that mounts Fastify-bound routers or names Fastify hooks is `HTTPPlugin<RouterTypes>`.
- Only the framework's pre-registered builders (shutdown policy, logger, cookies, error handling) hand a callback over with `builder[kAddConfigurer](configure)`, because they are constructed before an application can name one. Nothing else uses that symbol.
- A feature the application cannot configure from the tree implements `Feature` directly, not `FeatureBuilder`: `AuthorizationBuilder` and `GuardsBuilder`, whose factories (`Authorization(fn)`, `Guards(fn)`) run their callback immediately with no kit. Having nothing to read from the configuration is what decides it, not how much work the phases do.
