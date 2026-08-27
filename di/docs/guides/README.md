# Guides

Task-oriented documentation for common CaffeineIoC workflows. Start with
[Getting Started](./getting-started.md) if you are new to the library.

## Table of contents

- [Getting Started](./getting-started.md) — install CaffeineIoC, create your first
  container, and resolve your first dependency.

- [Configuring the Container](./configuring-container.md) — all `CaffeineIoC` constructor
  options: default scope, lazy mode, profiles, scope validation, circular reference
  detection, parent containers, and metadata readers.

- [Auto Load Decorated Classes](./scanning-files.md) — use `scan()` to auto-import all
  decorated source files in a directory, eliminating manual import lists in
  large codebases.

- [Decorators](./decorators.md) — annotate classes with `@Injectable`,
  `@Configuration`, `@Provides`, and all related decorators to declare
  dependencies without writing module functions.

- [Class Injection](./class.md) — configure constructor, property, and method
  injection; run post-construct setup and pre-destroy teardown.

- [Factory Classes](./factory-classes.md) — use `@Configuration` + `@Provides` to
  produce bindings from factory methods: third-party types, assembled values, and
  anything `@Injectable` cannot cover alone.

- [Abstract Classes](./abstract-classes.md) — register multiple implementations
  of an abstract class, inject all of them with `allOf`, and select between them
  using `@Named`, `@Primary`, and `@ConditionalOn`.

- [Interfaces](./interfaces.md) — use symbol tokens as runtime keys for TypeScript
  interfaces, with the same injection patterns as abstract classes.

- [Custom Injections](./custom-injections.md) — modify how individual dependencies
  are resolved: `optional`, `provide`, `defer`, `useValue`, and `compose`.

- [Collections](./collections.md) — inject all bindings under a key as an array
  with `allOf()`, or as a named map with `mapped()`.

- [Object Injection](./object-injection.md) — inject a group of dependencies as a
  single plain object using `object()`, including nested specs and optional properties.

- [Building Instances](./building-instances.md) — use `build()` for one-off instances
  and `builder()` for reusable compiled factories, both backed by container bindings.

- [Functions](./functions.md) — bind plain functions with `toFunction()` to produce closures,
  plain objects, or objects with methods, with dependencies injected positionally.

- [Factory](./factory.md) — bind a raw factory function with `toFactory()` to access the
  container directly at resolution time; useful for dynamic or conditional dependencies.

- [Conditional Bindings](./conditional-bindings.md) — register implementations only
  when a predicate passes at init time: region flags, env vars, feature toggles,
  or presence of another binding.

- [Fallback Bindings](./fallback-bindings.md) — mark a binding as a last-resort default,
  active only when no other non-fallback binding is registered for the same key; the
  standard pattern for overridable library defaults.

- [Lazy Bindings](./lazy-bindings.md) — defer construction of a binding until its first
  resolution; reduce startup time for expensive services and break circular dependency
  cycles.

- [Profiles](./profiles.md) — group bindings under named profiles (`test`, `production`,
  `eu`) and activate them via the container `profiles` option or `addProfiles()`.

- [Mixing Scopes](./mixing-scopes.md) — safely inject shorter-lived dependencies into
  longer-lived components using `provide()` and `Provider<T>`; scope validation options.

- [Async Bindings](./async-bindings.md) — bind keys to async factories using
  `toAsyncFactory()`, `@UseAsyncFactory`, or `@Async` + `@Provides`; constraints
  and ordering rules.

- [Testing](./testing.md) — write isolated tests with `TestContainer`: override
  bindings, focus on a dependency subtree, drop async bindings, and snapshot
  the global decorator registry.

- [Dependency Graph](./dependency-graph.md) — build and render the container's
  dependency graph as text, Markdown, Mermaid, DOT, or JSON.

- [Modules](./modules.md) — organize bindings into reusable module functions,
  name them for debugging, write async modules, and create child containers.
