import { coalesce, readEnv } from './_escape.js'
import type { ConfigChangeListener, ConfigDiagnostics, ConfigHandle } from './config.js'

/** What {@link Configuration} needs from the resolved configuration, without depending on the shard directly. */
export interface ConfigurationSource<T> {
  readonly handle: ConfigHandle<T>
  readonly snapshotHandle: ConfigHandle<T>
  readonly validated: T
  readonly revision: number
  readonly diagnostics: ConfigDiagnostics
  onChange(listener: ConfigChangeListener<T>): () => void
  settled(): Promise<void>
}

/**
 * The application's configuration, resolved with `container.get(Configuration)`.
 *
 * {@link config} is the ordinary way in and is the same handle bound under the application's own config key —
 * live, following every refresh. This class exists for the two things that handle cannot carry: a detached
 * snapshot, and the resolve metadata. The class key cannot name the application's config type, so `config` and
 * {@link snapshot} come back untyped here; read them through the config key when the type matters.
 *
 * A snapshot is deliberately **not** a member of the config object itself. The config object's keys are the
 * application's own, so a field named `snapshot` would collide with the accessor — the same hazard the
 * `origin` test already guards against.
 */
export class Configuration<T> {
  readonly #source: ConfigurationSource<T>

  constructor(source: ConfigurationSource<T>) {
    this.#source = source
  }

  /** The config object. Live: its fields follow every refresh. */
  get config(): ConfigHandle<T> {
    return this.#source.handle
  }

  /**
   * The same config object as {@link config}, fixed: a later refresh is not observed through it.
   *
   * What a request-scoped read is served from — the HTTP context latches one on first read, so a refresh
   * landing mid-request cannot change the answers a request already started with. It is one handle per
   * revision, shared, so taking one costs nothing.
   */
  get snapshotHandle(): ConfigHandle<T> {
    return this.#source.snapshotHandle
  }

  /**
   * The validated tree as it stands right now: plain, deep-frozen, and detached — a later refresh replaces the
   * tree rather than mutating it, so what this returns keeps the values it had when it was taken.
   *
   * The plain tree, as opposed to {@link snapshotHandle}: no feature-key lookup, and nothing to call.
   */
  snapshot(): T {
    return this.#source.validated
  }

  /** Advances only when a refresh actually re-resolved; a refresh with nothing to reload leaves it alone. */
  get revision(): number {
    return this.#source.revision
  }

  /** Where each value came from, and which features failed to resolve on the most recent pass. */
  get diagnostics(): ConfigDiagnostics {
    return this.#source.diagnostics
  }

  /**
   * Notified when the configuration changes. Returns the call that unsubscribes.
   *
   * Reading a field through {@link config} already follows every refresh, so this is for a caller that has to
   * *act* on a change rather than merely read the current value. It is not called at start-up, nor when a
   * refresh produced the same values.
   *
   * A refresh does not wait for the listener: it may be async, it never runs concurrently with itself, it is
   * given the newest configuration rather than a backlog, and a failure is reported through the warning channel
   * instead of escaping as an unhandled rejection.
   */
  onChange(listener: ConfigChangeListener<T>): () => void {
    return this.#source.onChange(listener)
  }

  /**
   * Resolves once no change notification is in flight or pending, at the root or in any feature slice.
   *
   * Here because notification is deliberately not awaited by a refresh, which would otherwise leave a test with
   * nothing to wait on. Nothing in the framework calls it.
   */
  settled(): Promise<void> {
    return this.#source.settled()
  }

  /**
   * Reads an environment variable straight from `process.env`, outside the configuration entirely: no schema,
   * no provider chain, no coercion. The escape hatch for a value that was never wired into the config.
   *
   * @param fallback - Returned when the variable is unset.
   */
  env(name: string): string | undefined
  env(name: string, fallback: string): string
  env(name: string, fallback?: string): string | undefined {
    return readEnv(name, fallback)
  }

  /**
   * The value `selector` reads from the live {@link config}, or `alternative` when that read yields `null` /
   * `undefined` or throws — a deep read through a path the schema left optional or undeclared.
   */
  either<R, A>(selector: (c: ConfigHandle<T>) => R, alternative: A): NonNullable<R> | A {
    return coalesce(this.config, selector, alternative)
  }
}
