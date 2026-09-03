# CaffeineIoC Documentation

IoC container for JavaScript and TypeScript.

## Tutorial

- [Tutorial](./tutorial) — Tutorials.

## Guides

Task-oriented documentation for common CaffeineIoC workflows.

- [Getting Started](./guides/getting-started.md) — install CaffeineIoC, create your first container, and resolve your first dependency.
- [Modules](./guides/modules.md) — organize bindings into reusable module functions.
- [Decorators](./guides/decorators.md) — annotate classes with `@Injectable`, `@Configuration`, `@Provides`, and related decorators.
- [Async Bindings](./guides/async-bindings.md) — bind keys to async factories; constraints and ordering rules.
- [Testing](./guides/testing.md) — write isolated tests with `TestContainer`.
- [Scanning Files](./guides/scanning-files.md) — use `scan()` to auto-import decorated source files.
- [Dependency Graph](./guides/dependency-graph.md) — render the container's dependency graph as text, Markdown, Mermaid, DOT, or JSON.

## Reference

Complete API documentation for CaffeineIoC.

- [Container](./reference/container.md) — the `CaffeineIoC` class: constructor options, resolution, binding, lifecycle, and inspection.
- [BindingSpec](./reference/binding-spec.md) — the `BindingSpec` fluent API.
- [Decorators](./reference/decorators.md) — all decorators exported from `@caffeinejs/di/decorators`.
- [Injection](./reference/injection.md) — injection helpers: `allOf`, `optional`, `provide`, `mapped`, `object`, `defer`, `useValue`, `compose`.
- [Scopes](./reference/scopes.md) — built-in scope identifiers, the `Scope` interface, and custom scope registry.
- [Hooks](./reference/hooks.md) — `HookListener` events emitted during container setup and runtime.
- [Errors](./reference/errors.md) — all `ErrXxx` error classes with codes and remediation guidance.
- [Factories](./reference/factories.md) — `Factory`, `AsyncFactory`, `ResolutionContext`.
- [Interceptors](./reference/interceptors.md) — `PostResolutionInterceptor` and `PostProcessor`.
- [Graph](./reference/graph.md) — five graph renderer functions.

## Explanation

Conceptual background on how and why CaffeineIoC works the way it does.

- [What is dependency injection?](./explanation/what-is-di.md) — the problem DI solves and why a container helps.
- [Container lifecycle](./explanation/container-lifecycle.md) — construction, init, resolution, and disposal phases.
- [Thinking in scopes](./explanation/thinking-in-scopes.md) — mental model for scope selection, scope leaks, and how to fix them.
- [Decorator modes](./explanation/decorator-modes.md) — stage 3 decorators vs. legacy TypeScript decorators vs. programmatic API.
