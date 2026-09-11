import { coalesce, readEnv } from './_escape.js'
import type { ConfigChangeListener, ConfigSchema } from './config.js'
import { ErrConfig } from './errors.js'
import { ConfigNotifier } from './notifier.js'

/**
 * A feature's configuration.
 *
 * `config` is *the* config object — there is no live variant and a plain variant. Its identity never changes,
 * and every field reads through to whatever the most recent refresh published. That is what lets a feature
 * hand its configuration to a collaborator, or keep it on a field, without having handed over a stale object.
 *
 * A read is a getter call over a plain object: no proxy, no path walk, nothing allocated. Deliberately not the
 * {@link ConfigHandle} proxy the application's config key is bound to — that one exists to give an application
 * ergonomic access to a tree it declared, and pays for it with a trap on every access.
 *
 * {@link snapshot} is the escape hatch for a caller that explicitly wants a detached, point-in-time copy.
 * Nothing in the framework uses it; it is the primitive a request-scoped snapshot would be built from.
 */
export class ConfigSlice<T> {
  /**
   * Where in the configuration tree this slice reads from, or `undefined` when it is **detached** — the
   * application never pointed the feature at a location, so its values come from the feature's own defaults
   * and its builder alone.
   */
  readonly parts: readonly string[] | undefined
  readonly #notifier: ConfigNotifier<T>
  #current: T | undefined
  #config: T | undefined
  #published = false
  #error: unknown

  /**
   * @param report - Where a change listener's failure is reported. Read lazily rather than taken by value: the
   *   application builder points the warning channel at the host after the slices have been registered.
   */
  constructor(
    parts: readonly string[] | undefined,
    report: () => ((message: string) => void) | undefined = () => undefined,
  ) {
    this.parts = parts
    this.#notifier = new ConfigNotifier<T>(() => sliceLabel(this.parts), report)
  }

  /**
   * The config object: stable identity, fields following every refresh.
   *
   * After a refresh that failed for this slice, the fields keep serving the last values that did validate —
   * a feature never observes a half-updated object. A slice that has *never* validated rethrows the failure
   * that stopped it rather than pretending to be empty.
   *
   * Because the identity is stable, this is what a feature hands to whatever it constructs, and the one case
   * where `toValue` does not freeze a configuration: `bind(key, t => t.toValue(slice.config))` gives a
   * container-constructed class an object whose fields keep moving.
   *
   * A slice resolving to a **primitive** has no facade to read through, so binding it by value would freeze it
   * at the first resolve. Read one through a factory instead.
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
   * The value `selector` reads from this slice's {@link config}, or `alternative` when that read yields `null` /
   * `undefined` or throws.
   *
   * @throws ErrConfig `ERR_CONFIG_NOT_RESOLVED` when the slice has not published yet — reading too early is a
   *   lifecycle error, not a missing value.
   */
  either<R, A>(selector: (c: T) => R, alternative: A): NonNullable<R> | A {
    return coalesce(this.config, selector, alternative)
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

  /** Resolves once no change notification is in flight or pending. */
  settled(): Promise<void> {
    return this.#notifier.settled()
  }

  /** Framework-internal: called by the config shard on bootstrap and on every refresh. */
  publish(value: T): void {
    this.#current = value
    this.#published = true
    this.#error = undefined

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

  #require(): T {
    if (!this.#published) {
      if (this.#error !== undefined) {
        throw this.#error
      }
      throw new ErrConfig(
        `Cannot read config "${sliceLabel(this.parts)}": configuration has not been resolved yet`,
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

/** How a slice names itself in an error, a warning or the diagnostics. */
export function sliceLabel(parts: readonly string[] | undefined): string {
  if (parts === undefined) {
    return '<detached>'
  }

  return parts.join('.') || '<root>'
}

/**
 * A feature slice registration: where in the tree it lives, and the schema that governs it.
 *
 * A detached slice — `parts` `undefined` — is validated from {@link local} instead of from the tree, so a
 * feature the application never pointed anywhere still resolves against its own defaults.
 */
export interface ConfigSliceSpec<T = unknown> {
  parts: readonly string[] | undefined
  schema: ConfigSchema<T>
  slice: ConfigSlice<T>
  /** The input a detached slice validates. Ignored for a slice that has a location. */
  local?: Record<string, unknown>
}
