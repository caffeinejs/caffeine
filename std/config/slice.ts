import { ErrConfig } from './errors.js'
import type { ConfigChangeListener } from './notifier.js'
import { ConfigNotifier } from './notifier.js'
import type { ConfigSchema } from './schema.js'

/**
 * A feature's configuration.
 *
 * `config` is *the* config object — there is no live variant and a plain variant. Its identity never changes,
 * and every field reads through to whatever the most recent refresh published. That is what lets a feature
 * hand its configuration to a collaborator, or keep it on a field, without having handed over a stale object.
 *
 * A read is a getter call over a plain object: no proxy, no path walk, nothing allocated. Deliberately not the
 * {@link ConfigHandle} proxy `kAppConfig` is bound to — that one exists to give an application ergonomic
 * access to a tree it declared, and pays for it with a trap on every access.
 *
 * {@link snapshot} is the escape hatch for a caller that explicitly wants a detached, point-in-time copy.
 * Nothing in the framework uses it; it is the primitive a request-scoped snapshot would be built from.
 */
export class ConfigSlice<T> {
  readonly parts: readonly string[]
  readonly #derivations: Array<(value: T) => void> = []
  readonly #derived: Array<{ notify: () => void; settled: () => Promise<void> }> = []
  readonly #notifier: ConfigNotifier<T>
  readonly #report: () => ((message: string) => void) | undefined
  #current: T | undefined
  #config: T | undefined
  #published = false
  #error: unknown

  /**
   * @param report - Where a change listener's failure is reported. Read lazily rather than taken by value: the
   *   application builder points the warning channel at the host after the slices have been registered.
   */
  constructor(parts: readonly string[], report: () => ((message: string) => void) | undefined = () => undefined) {
    this.parts = parts
    this.#report = report
    this.#notifier = new ConfigNotifier<T>(() => this.parts.join('.') || '<root>', report)
  }

  /**
   * The config object: stable identity, fields following every refresh.
   *
   * After a refresh that failed for this slice, the fields keep serving the last values that did validate —
   * a feature never observes a half-updated object. A slice that has *never* validated rethrows the failure
   * that stopped it rather than pretending to be empty.
   */
  get config(): T {
    const current = this.#require()

    // A facade only exists to give an *object* a stable identity while its fields move. A primitive has no
    // fields to read through, and caching one would freeze it at whatever the first resolve produced — so a
    // derivation that computes a scalar reads straight through instead.
    if (current === null || typeof current !== 'object') {
      return current
    }

    this.#config ??= this.#buildFacade(current)
    return this.#config
  }

  /** A detached, deep-frozen copy of the current values. Unaffected by later refreshes. */
  snapshot(): T {
    return this.#require()
  }

  /** The failure from the most recent publish, or `undefined` when the last one succeeded. */
  get error(): unknown {
    return this.#error
  }

  get published(): boolean {
    return this.#published
  }

  /**
   * Notified when this slice's values actually change. Returns the call that unsubscribes.
   *
   * Reading a field already follows every refresh — {@link config} sees to that — so this is for a feature that
   * has to *act*: resize a pool, reopen a connection, re-arm a timer. Nothing is delivered at start-up, since
   * the first configuration is not a change; nothing is delivered when a refresh produced the same values; and
   * nothing is delivered for a refresh this slice failed, because a failed slice keeps its last good value and
   * therefore did not change.
   *
   * A refresh does not wait for the listener. It may be async, it will not run concurrently with itself, and it
   * always receives the newest configuration rather than a backlog. A failure is reported through the warning
   * channel rather than escaping.
   */
  onChange(listener: ConfigChangeListener<T>): () => void {
    return this.#notifier.add(listener)
  }

  /** Resolves once no change notification is in flight or pending, here or in anything derived from this. */
  async settled(): Promise<void> {
    await Promise.all([this.#notifier.settled(), ...this.#derived.map(derived => derived.settled())])
  }

  /** Framework-internal: called by the config shard on bootstrap and on every refresh. */
  publish(value: T): void {
    this.#current = value
    this.#published = true
    this.#error = undefined

    for (const derivation of this.#derivations) {
      derivation(value)
    }

    this.#notifier.record(value)
  }

  /**
   * Framework-internal: delivers the change recorded by the most recent {@link publish}.
   *
   * Separate from publishing so the shard can publish every slice before any listener runs. A listener that ran
   * mid-publish would find the features that had not been reached yet still holding their previous values.
   */
  notify(): void {
    this.#notifier.flush()

    for (const derived of this.#derived) {
      derived.notify()
    }
  }

  /**
   * Framework-internal: records that this slice could not be resolved.
   *
   * The previous values stay in place. A failure is isolated to the feature it belongs to — one bad
   * environment variable must not take down configuration for everything else in the process.
   */
  fail(error: unknown): void {
    this.#error = error
  }

  /**
   * Configuration computed from this slice — the shape a feature actually wants, folded over its defaults and
   * merged with whatever cannot travel through a configuration tree (a dispatcher, a handler, a class).
   *
   * Recomputed **when the slice publishes**, not when the result is read. That ordering matters: deriving a
   * feature's options can reject a combination that validates field by field but not as a whole, and a refresh
   * is where that has to surface — not later, from inside whatever happened to read it first.
   */
  derive<U>(compute: (config: T) => U): ConfigSlice<U> {
    const derived = new ConfigSlice<U>(this.parts, this.#report)

    const recompute = (value: T): void => {
      derived.publish(compute(value))
    }

    this.#derivations.push(recompute)
    // A feature holds the derived slice, not this one, so its listeners have to be reached by the same notify
    // pass — and only after every slice has published.
    this.#derived.push({ notify: () => derived.notify(), settled: () => derived.settled() })

    if (this.#published) {
      recompute(this.#current as T)
    }

    return derived
  }

  #require(): T {
    if (!this.#published) {
      if (this.#error !== undefined) {
        throw this.#error
      }
      throw new ErrConfig(
        `Cannot read config "${this.parts.join('.') || '<root>'}": configuration has not been resolved yet`,
        'ERR_CONFIG_NOT_RESOLVED',
        undefined,
        'Read the configuration from inside a service, not while the application is still being built',
        'Await "container.init()" (or "app.run(...)") before touching the value',
      )
    }
    return this.#current as T
  }

  /**
   * Builds the facade once, from the key set of the first published value. The keys come from the feature's
   * schema, so they do not vary between refreshes.
   *
   * Each property is handed back exactly as it is held — nothing is wrapped on the way out. A nested object is
   * therefore the one the last refresh published, and a value that is not configuration at all comes back as
   * the very object that was merged in, identity intact.
   */
  #buildFacade(current: T): T {
    const facade: Record<string, unknown> = {}

    for (const key of Object.keys(current as object)) {
      Object.defineProperty(facade, key, {
        enumerable: true,
        get: () => (this.#require() as Record<string, unknown>)[key],
      })
    }

    return facade as T
  }
}

/** A feature slice registration: where in the tree it lives, and the schema that governs it. */
export interface ConfigSliceSpec<T = unknown> {
  parts: readonly string[]
  schema: ConfigSchema<T>
  slice: ConfigSlice<T>
}

/** Freezes a validated tree, so nothing downstream can mutate shared configuration. */
export function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value
  }

  for (const key of Object.keys(value as object)) {
    freezeDeep((value as Record<string, unknown>)[key])
  }

  return Object.freeze(value)
}
