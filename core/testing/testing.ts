import { DiCaf } from '../container.js'
import { Container } from '../container_interface.js'
import { Identifier, Key, TypedKey } from '../key.js'
import { Module } from '../module.js'
import { Snapshot } from '../snapshot.js'
import { Binder } from '../binder.js'
import { exclusiveDeps, allTransitiveDeps } from './_util.js'

interface IsolationEntry {
  configure: (binder: Binder<any>) => void
  pruneSharedDependencies: boolean
}

/**
 * TestContainer is a fluent builder that takes a {@link Container} or {@link Snapshot},
 * applies filters, transformations, and produces an uninitialized {@link Container},
 * suitable for use in tests.
 *
 * By default, the resulting container will be lazy.
 *
 * @testing
 */
export class TestContainer {
  readonly #snap: Snapshot
  readonly #overrides = new Map<Key, (binder: Binder<any>) => void>()
  readonly #isolations = new Map<Key, IsolationEntry>()
  readonly #skips = new Set<Key>()

  #asyncPolicy: Set<Key> | null = null
  #focusRoots: Set<Key> | null = null
  #profiles: Identifier[] | null = null
  #modules: Module[] = []
  #lazy: boolean = true

  constructor(container: Container)
  constructor(snap: Snapshot)
  constructor(source: Container | Snapshot) {
    if (source == null) {
      throw new Error('TestContainer requires either a Container instance or a container Snapshot')
    }

    this.#snap = source instanceof Snapshot ? source : source.snapshot()
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
  modules(module: Module, ...rest: Module[]): this {
    this.#modules.push(module, ...rest)
    return this
  }

  /**
   * Replaces the binding for `key` in the test container.
   *
   * The `configure` callback receives a {@link Binder} pre-linked to `key`, so the full
   * binding DSL is available: `.toValue()`, `.toClass()`, `.toFactory()`, `.toFunction()`,
   * and all {@link BinderOptions} modifiers (`.lifetime()`, `.lazy()`, `.names()`, etc.).
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
  override<T>(key: Key<T>, configure: (binder: Binder<T>) => void): this {
    this.#overrides.set(key, configure as (binder: Binder<any>) => void)
    return this
  }

  /**
   * Replaces the binding for `key` in the test container with the given value.
   *
   * @example
   * ```ts
   * new TestContainer(source)
   *   .overrideWithValue(Repository, mockRepo)
   *   .build()
   * ```
   */
  overrideWithValue<T>(key: Key<T>, value: T): this {
    return this.override(key, b => b.toValue(value))
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
   * The `configure` callback receives a {@link Binder} pre-linked to `key`, giving access
   * to the full binding DSL: `.toValue()`, `.toClass()`, `.toFactory()`, `.toFunction()`,
   * and all {@link BinderOptions} modifiers.
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
  isolate<T>(key: Key<T>, pruneSharedDependencies: boolean, configure: (binder: Binder<T>) => void): this {
    this.#isolations.set(key, { configure, pruneSharedDependencies })
    return this
  }

  /**
   * Replaces the binding for `key` with the given value and prunes its dependencies.
   *
   * Shorthand for `.isolate(key, pruneSharedDependencies, b => b.toValue(value))`.
   *
   * When `pruneSharedDependencies` is `false`, only dependencies exclusive to `key`
   * are pruned. When `true`, all transitive dependencies are pruned.
   *
   * @example
   * ```ts
   * new TestContainer(source)
   *   .isolateWithValue(Repository, false, mockRepo)
   *   .build()
   * ```
   */
  isolateWithValue<T>(key: Key<T>, pruneSharedDependencies: boolean, value: T): this {
    return this.isolate(key, pruneSharedDependencies, b => b.toValue(value))
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
  skipAsyncBindings(...exceptions: Key[]): this {
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
  skip(key: Key, ...rest: Key[]): this {
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
   *   .overrideWithValue(Repository, mockRepo)
   *   .build()
   * ```
   */
  focus(root: Key, ...rest: Key[]): this {
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
      const exempt = new Set<Key>([...this.#overrides.keys(), ...this.#isolations.keys()])
      snap = snap.filter((k, b) => !b.async || this.#asyncPolicy!.has(k) || exempt.has(k))
    }

    if (this.#focusRoots != null) {
      const kept = new Set<Key>(this.#focusRoots)
      for (const k of allTransitiveDeps(snap, this.#focusRoots)) {
        kept.add(k)
      }
      snap = snap.filter(k => kept.has(k))
    }

    if (this.#isolations.size > 0) {
      const isolatedKeys = new Set(this.#isolations.keys())
      const exclusiveKeys = new Set<Key>()
      const allDepKeys = new Set<Key>()

      for (const [key, { pruneSharedDependencies: pruneShared }] of this.#isolations) {
        if (pruneShared) {
          allDepKeys.add(key)
        } else {
          exclusiveKeys.add(key)
        }
      }

      const pruned = new Set<Key>()

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

    const di = new DiCaf(
      {
        decorators: false,
        lazy: this.#lazy,
        ...(this.#profiles != null && { profiles: this.#profiles }),
      },
      ...this.#modules,
    )
    di.restore(snap)

    for (const [key, { configure }] of this.#isolations) {
      configure(di.rebind(key as TypedKey<any>))
    }

    for (const [key, configure] of this.#overrides) {
      configure(di.rebind(key as TypedKey<any>))
    }

    return di
  }
}

/**
 * Creates a new test container using the given {@link Container} as the base.
 * All the bindings from the base container will be available in the new container.
 * You can use the test container to override, filter, isolate, and focus on specific bindings.
 *
 * @param container - The base container to use as the foundation for the test container.
 *
 * @testing
 */
export function newTestContainer(container: Container): TestContainer
/**
 * Creates a new test container using the given {@link Snapshot} as the base.
 * All the bindings from the snapshot will be available in the new container.
 * You can use the test container to override, filter, isolate, and focus on specific bindings.
 *
 * @param snap - The snapshot to use as the foundation for the test container.
 *
 * @testing
 */
export function newTestContainer(snap: Snapshot): TestContainer
/**
 * Creates a new test container using the given {@link Container} or {@link Snapshot} as the base.
 * All the bindings from the container or snapshot will be available in the new container.
 * You can use the test container to override, filter, isolate, and focus on specific bindings.
 *
 * @param source - The container or snapshot to use as the foundation for the test container.
 *
 * @testing
 */
export function newTestContainer(source: Container | Snapshot): TestContainer {
  return new TestContainer(source as Container)
}
