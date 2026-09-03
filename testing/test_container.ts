import { CaffeineIoC } from '@caffeinejs/di'
import type {
  BindingSpec,
  Container,
  Identifier,
  InjectionToken,
  Module,
  ModuleFn,
  Snapshot,
  TokenValue,
} from '@caffeinejs/di'

import { allTransitiveDeps, exclusiveDeps } from './_graph.js'

interface IsolationEntry {
  configure: (spec: BindingSpec<any, any>) => void
  pruneSharedDependencies: boolean
}

/**
 * TestContainer is a fluent builder that takes a {@link Container} or {@link Snapshot},
 * or constructs an empty container when called with no arguments. It applies filters
 * and transformations and produces an uninitialized {@link Container}, suitable for use
 * in tests.
 *
 * The empty constructor creates a container internally so a test can import a single
 * feature module instead of the whole application graph.
 *
 * By default, the resulting container will be lazy.
 */
export class TestContainer {
  readonly #snap: Snapshot
  readonly #fromScratch: boolean
  readonly #overrides = new Map<InjectionToken, (spec: BindingSpec<any, any>) => void>()
  readonly #isolations = new Map<InjectionToken, IsolationEntry>()
  readonly #skips = new Set<InjectionToken>()

  #asyncPolicy: Set<InjectionToken> | null = null
  #focusRoots: Set<InjectionToken> | null = null
  #profiles: Identifier[] | null = null
  #modules: Array<Module | ModuleFn> = []
  #lazy: boolean = true

  constructor()
  constructor(container: Container)
  constructor(snap: Snapshot)
  constructor(source?: Container | Snapshot) {
    if (source === undefined) {
      this.#fromScratch = true
      this.#snap = new CaffeineIoC().snapshot()
      return
    }

    if (source == null) {
      throw new Error('TestContainer requires either a Container instance or a container Snapshot')
    }

    this.#fromScratch = false
    this.#snap = source instanceof CaffeineIoC ? source.snapshot() : (source as Snapshot)
  }

  /**
   * Sets the lazy loading behavior for the test container.
   */
  lazy(value: boolean): this {
    this.#lazy = value
    return this
  }

  /**
   * Activates the given profiles in the test container.
   */
  profiles(profile: Identifier, ...rest: Identifier[]): this {
    if (this.#profiles == null) {
      this.#profiles = []
    }
    this.#profiles.push(profile, ...rest)
    return this
  }

  /**
   * Adds modules to the test container.
   *
   * Modules run during {@link Container.init} and can register bindings imperatively.
   * May be called multiple times — modules accumulate across calls and run in insertion order.
   *
   * @example
   * ```ts
   * new TestContainer(source)
   *   .modules(infraModule, testOverridesModule)
   *   .build()
   * ```
   */
  modules(module: Module | ModuleFn, ...rest: Array<Module | ModuleFn>): this {
    this.#modules.push(module, ...rest)
    return this
  }

  /**
   * Replaces the binding for `key` in the test container.
   *
   * The `configure` callback receives a {@link BindingSpec} pre-linked to `key`, so the full
   * binding DSL is available: `.toValue()`, `.toClass()`, `.toFactory()`, `.toFunction()`,
   * and all its modifiers (`.lifetime()`, `.lazy()`, `.names()`, etc.).
   *
   * Overriding a key that was removed by {@link skipAsyncBindings} re-adds it — the override
   * is always exempt from async filters.
   *
   * Calls chain: each `.override()` returns `this`.
   *
   * @example
   * ```ts
   * new TestContainer(source)
   *   .override(Repository, b => b.toValue(mockRepo))
   *   .override(Cache, b => b.toClass(InMemoryCache).lifetime(Scope.Singleton))
   *   .build()
   * ```
   */
  override<K extends InjectionToken<any>>(key: K, configure: (spec: BindingSpec<TokenValue<K>, K>) => void): this {
    this.#overrides.set(key, configure as (spec: BindingSpec<any, any>) => void)
    return this
  }

  /**
   * Replaces the binding for `key` in the test container with a mock or ready-made value.
   *
   * `mock` is typed as `T | object` so a vitest mock or a duck-typed fake can be passed
   * without a double assertion (`as unknown as T`).
   *
   * @example
   * ```ts
   * new TestContainer(source)
   *   .overrideWithMock(Repository, mockRepo)
   *   .build()
   * ```
   */
  overrideWithMock<T>(key: InjectionToken<T>, mock: T | object): this {
    return this.override(key, b => b.toValue(mock as T))
  }

  /**
   * Replaces the binding for `key` in the test container and prunes its dependencies.
   *
   * When `pruneSharedDependencies` is `false`, only dependencies that are **exclusive**
   * to `key` (not referenced by any other binding) are pruned. Dependencies shared with
   * other bindings are preserved.
   *
   * When `pruneSharedDependencies` is `true`, **all** transitive dependencies of `key`
   * are pruned, regardless of whether other bindings reference them.
   *
   * The `configure` callback receives a {@link BindingSpec} pre-linked to `key`, giving access
   * to the full binding DSL: `.toValue()`, `.toClass()`, `.toFactory()`, `.toFunction()`,
   * and all its modifiers.
   *
   * Keys registered via `isolate` are always exempt from {@link skipAsyncBindings} filters.
   *
   * @example
   * ```ts
   * new TestContainer(source)
   *   .isolate(Repository, false, b => b.toValue(mockRepo))
   *   .isolate(Cache, true, b => b.toClass(InMemoryCache).lifetime(Scope.Singleton))
   *   .build()
   * ```
   */
  isolate<K extends InjectionToken<any>>(
    key: K,
    pruneSharedDependencies: boolean,
    configure: (spec: BindingSpec<TokenValue<K>, K>) => void,
  ): this {
    this.#isolations.set(key, {
      configure: configure as (spec: BindingSpec<any, any>) => void,
      pruneSharedDependencies,
    })
    return this
  }

  /**
   * Replaces the binding for `key` with a mock or ready-made value and prunes its dependencies.
   *
   * Shorthand for `.isolate(key, pruneSharedDependencies, b => b.toValue(mock))`.
   *
   * `mock` is typed as `T | object` so a vitest mock or a duck-typed fake can be passed
   * without a double assertion (`as unknown as T`).
   *
   * When `pruneSharedDependencies` is `false`, only dependencies exclusive to `key`
   * are pruned. When `true`, all transitive dependencies are pruned.
   *
   * @example
   * ```ts
   * new TestContainer(source)
   *   .isolateWithMock(Repository, false, mockRepo)
   *   .build()
   * ```
   */
  isolateWithMock<T>(key: InjectionToken<T>, pruneSharedDependencies: boolean, mock: T | object): this {
    return this.isolate(key, pruneSharedDependencies, b => b.toValue(mock as T))
  }

  /**
   * Removes all async bindings from the test container,
   * keeping only the specified exceptions.
   *
   * Keys registered via {@link override} or {@link isolate} are always exempt.
   * May be called multiple times — exceptions accumulate across calls.
   *
   * @param exceptions - Async binding keys to keep. Omit to drop all async bindings.
   *
   * @example
   * ```ts
   * // drop all async bindings
   * new TestContainer(source).skipAsyncBindings().build()
   *
   * // drop all async except kConn and kDb (two calls — same as skipAsyncBindings(kConn, kDb))
   * new TestContainer(source).skipAsyncBindings(kConn).skipAsyncBindings(kDb).build()
   * ```
   */
  skipAsyncBindings(...exceptions: InjectionToken[]): this {
    if (this.#asyncPolicy == null) {
      this.#asyncPolicy = new Set()
    }
    for (const k of exceptions) {
      this.#asyncPolicy.add(k)
    }
    return this
  }

  /**
   * Removes the listed bindings from the test container.
   */
  skip(key: InjectionToken, ...rest: InjectionToken[]): this {
    this.#skips.add(key)
    for (const k of rest) {
      this.#skips.add(k)
    }
    return this
  }

  /**
   * Restricts the test container to only the bindings reachable from the given root keys.
   *
   * The container will include each root key and all of its transitive dependencies.
   * Any binding not in that set is dropped. When multiple roots are provided, the
   * container keeps the union of all their dependency trees.
   *
   * May be called multiple times — roots accumulate across calls.
   *
   * Composes with {@link override} and {@link isolate}. Use `override` to replace one of the
   * focused deps with a mock while keeping the rest of the tree real. Use `isolate` for pruning
   * — dep analysis runs against the already-focused snapshot, so pruning reflects the narrowed scope.
   *
   * @example
   * ```ts
   * // single root — keeps Controller and its deps, drops everything else
   * new TestContainer(source).focus(Controller).build()
   *
   * // multiple roots — keeps union of both trees
   * new TestContainer(source).focus(Controller, UnrelatedService).build()
   *
   * // mock one dep of the focused tree
   * new TestContainer(source)
   *   .focus(Controller)
   *   .overrideWithMock(Repository, mockRepo)
   *   .build()
   * ```
   */
  focus(root: InjectionToken, ...rest: InjectionToken[]): this {
    if (this.#focusRoots == null) {
      this.#focusRoots = new Set()
    }
    this.#focusRoots.add(root)
    for (const k of rest) {
      this.#focusRoots.add(k)
    }
    return this
  }

  /**
   * Builds a new {@link Container} based on the test container configuration.
   */
  build(): Container {
    let snap = this.#snap

    if (this.#asyncPolicy != null) {
      const exempt = new Set<InjectionToken>([...this.#overrides.keys(), ...this.#isolations.keys()])
      snap = snap.filter((k, b) => !b.async || this.#asyncPolicy!.has(k) || exempt.has(k))
    }

    if (this.#focusRoots != null) {
      const kept = new Set<InjectionToken>(this.#focusRoots)
      for (const k of allTransitiveDeps(snap, this.#focusRoots)) {
        kept.add(k)
      }
      snap = snap.filter(k => kept.has(k))
    }

    if (this.#isolations.size > 0) {
      const isolatedKeys = new Set(this.#isolations.keys())
      const exclusiveKeys = new Set<InjectionToken>()
      const allDepKeys = new Set<InjectionToken>()

      for (const [key, { pruneSharedDependencies: pruneShared }] of this.#isolations) {
        if (pruneShared) {
          allDepKeys.add(key)
        } else {
          exclusiveKeys.add(key)
        }
      }

      const pruned = new Set<InjectionToken>()

      if (exclusiveKeys.size > 0) {
        for (const k of exclusiveDeps(snap, exclusiveKeys)) {
          pruned.add(k)
        }
      }

      if (allDepKeys.size > 0) {
        for (const k of allTransitiveDeps(snap, allDepKeys)) {
          pruned.add(k)
        }
      }

      snap = snap.filter(k => !pruned.has(k) && !isolatedKeys.has(k))
    }

    if (this.#skips.size > 0) {
      snap = snap.filter(k => !this.#skips.has(k))
    }

    const di = new CaffeineIoC({
      decorators: this.#fromScratch,
      lazy: this.#lazy,
      ...(this.#profiles != null && { profiles: this.#profiles }),
      modules: this.#modules,
    })
    di.restore(snap)

    for (const [key, { configure }] of this.#isolations) {
      di.rebind(key as any, configure)
    }

    for (const [key, configure] of this.#overrides) {
      di.rebind(key as any, configure)
    }

    return di
  }
}

/**
 * Creates a new test container with an empty internal container.
 * Use {@link TestContainer.modules} to load a feature module without importing the
 * whole application graph.
 */
export function newTestContainer(): TestContainer
/**
 * Creates a new test container using the given {@link Container} as the base.
 * All the bindings from the base container will be available in the new container.
 * You can use the test container to override, filter, isolate, and focus on specific bindings.
 *
 * @param container - The base container to use as the foundation for the test container.
 */
export function newTestContainer(container: Container): TestContainer
/**
 * Creates a new test container using the given {@link Snapshot} as the base.
 * All the bindings from the snapshot will be available in the new container.
 * You can use the test container to override, filter, isolate, and focus on specific bindings.
 *
 * @param snap - The snapshot to use as the foundation for the test container.
 */
export function newTestContainer(snap: Snapshot): TestContainer
/**
 * Creates a new test container using the given {@link Container} or {@link Snapshot} as the base,
 * or an empty internal container when called with no arguments.
 * You can use the test container to override, filter, isolate, and focus on specific bindings.
 *
 * @param source - The container or snapshot to use as the foundation for the test container.
 */
export function newTestContainer(source?: Container | Snapshot): TestContainer {
  if (source === undefined) {
    return new TestContainer()
  }
  return new TestContainer(source as Container)
}
