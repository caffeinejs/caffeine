# Reference

Complete API documentation for DiCaf. For task-oriented guides, see the
[Guides](../guides/README.md) section.

## Core documents

The following documents cover the APIs you will use most often:

- [Container](./container.md) — the `DiCaf` class: constructor options, all
  resolution, binding, lifecycle, and inspection methods.

- [Binder](./binder.md) — the `Binder` and `BinderOptions` fluent APIs
  returned by `di.bind()`.

- [Decorators](./decorators.md) — every decorator exported from
  `@caffeine-projects/dicaf/decorators`, with signatures and examples.

- [Injection](./injection.md) — the `Injection` type, `InjectionDescriptor`,
  and all injection helpers: `allOf`, `optional`, `provide`, `mapped`,
  `object`, `defer`, `useValue`, `compose`.

- [Factories](./factories.md) — `Factory`, `AsyncFactory`, and `ResolutionContext`.

- [Interceptors](./interceptors.md) — `PostResolutionInterceptor` (per-binding) and `PostProcessor` (global).

## Reference table of contents

- [Binder](./binder.md) — `Binder<T>` and `BinderOptions<T>` fluent APIs.

- [Container](./container.md) — `DiCaf` constructor, resolution methods,
  binding methods, lifecycle, and properties.

- [Options](./options.md) — all `DiCaf` constructor options with types, defaults,
  and `ScopeCheckMode` values.

- [Decorators](./decorators.md) — all class, method, member, and configuration
  decorators.

- [Errors](./errors.md) — all `ErrXxx` error classes with error codes and
  remediation guidance.

- [Factories](./factories.md) — factory function types and resolution context.

- [Interceptors](./interceptors.md) — per-binding and global instance interceptors.

- [Graph](./graph.md) — five graph renderer functions: text, Markdown,
  Mermaid, DOT, and JSON.

- [Hooks](./hooks.md) — `HookListener` events emitted during container setup
  and runtime.

- [Injection](./injection.md) — injection descriptor type and helper functions.

- [Scopes](./scopes.md) — built-in scope identifiers, the `Scope` interface,
  and the scope registry API for custom scopes.
