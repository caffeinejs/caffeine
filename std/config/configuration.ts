import type { ConfigHandle } from './accessor.js'
import type { ConfigDiagnostics } from './diagnostics.js'
import type { ConfigChangeListener } from './notifier.js'

/** DI key for the application {@link Configuration}. `kAppConfig` stays bound to the config object itself. */
export const kConfiguration = Symbol.for('@caffeinejs/std:configuration')

/** What {@link Configuration} needs from the resolved configuration, without depending on the shard directly. */
export interface ConfigurationSource<T> {
  readonly handle: ConfigHandle<T>
  readonly validated: T
  readonly revision: number
  readonly diagnostics: ConfigDiagnostics
  onChange(listener: ConfigChangeListener<T>): () => void
  settled(): Promise<void>
}

/**
 * The application's configuration.
 *
 * {@link config} is the ordinary way in and is the same object bound under `kAppConfig` — live, following
 * every refresh. This class exists for the two things that object cannot carry: a detached snapshot, and the
 * resolve metadata.
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
   * The validated tree as it stands right now: plain, deep-frozen, and detached — a later refresh replaces the
   * tree rather than mutating it, so what this returns keeps the values it had when it was taken.
   *
   * Nothing in the framework uses it. It is here for a caller that explicitly wants a fixed view — the
   * primitive a request-scoped snapshot is built from.
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
}
