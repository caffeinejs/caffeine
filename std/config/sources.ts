import type { ConfigProvider } from './config.js'

/**
 * Where a source sits in the precedence chain. Higher wins.
 *
 * The bands exist because registration order cannot express precedence here: feature builders register their
 * values at `configure()`, which runs *after* the application builder collected the user's sources, so
 * ordering alone would make a code-set default beat an environment variable — exactly backwards for anything
 * that ships as a container image.
 *
 * The chain deliberately mirrors the twelve-factor arrangement: the binary carries defaults, the deployment
 * overrides them.
 */
export const ConfigPriority = {
  /** Framework defaults — `DEFAULT_SERVER_OPTIONS` and friends. Always loses. */
  FRAMEWORK: 0,
  /**
   * Defaults declared by the application's own schema, e.g. `$t.Number({ default: 9999 })`.
   *
   * Above the framework's so an application can default a feature it did not write, and below `CODE` so an
   * explicit builder call still wins: declaring a shape is a weaker statement than calling a method.
   */
  SCHEMA: 25,
  /** Values set through a feature builder method, e.g. `s.port(3000)`. A default, not an override. */
  CODE: 50,
  /** The default band for `.source(...)`. Registration order breaks ties within it. */
  USER: 100,
  FILE: 200,
  ENV: 300,
  ARGS: 400,
} as const

export type ConfigPriorityValue = (typeof ConfigPriority)[keyof typeof ConfigPriority] | number

interface Registration {
  provider: ConfigProvider
  priority: number
  seq: number
}

/**
 * A live, ordered registry of configuration sources.
 *
 * Live is the point: {@link ConfigEngine} reads it on **every** resolve rather than capturing a list up front,
 * so a source added before `container.init()` lands on the first bootstrap and one added afterwards lands on the
 * next refresh. This is what lets a feature contribute its own values long after the application builder ran.
 */
export class ConfigSources {
  /** A registry holding the given providers in the `USER` band, in order. */
  static of(...providers: readonly ConfigProvider[]): ConfigSources {
    return new ConfigSources().addAll(providers)
  }

  readonly #registrations: Registration[] = []
  #seq = 0
  #revision = 0
  #cache: readonly ConfigProvider[] | undefined
  #cachedRevision = -1

  /** Registers a source. Defaults to {@link ConfigPriority.USER}; ties are broken by registration order. */
  add(provider: ConfigProvider, priority: ConfigPriorityValue = ConfigPriority.USER): this {
    this.#registrations.push({ provider, priority, seq: this.#seq++ })
    this.#revision++
    return this
  }

  /** Registers several sources at once, all in the same band, in the given order. */
  addAll(providers: readonly ConfigProvider[], priority: ConfigPriorityValue = ConfigPriority.USER): this {
    for (const provider of providers) {
      this.add(provider, priority)
    }
    return this
  }

  /** Removes every source with the given id. Returns whether anything was removed. */
  remove(id: string): boolean {
    let removed = false
    for (let i = this.#registrations.length - 1; i >= 0; i--) {
      if (this.#registrations[i].provider.id === id) {
        this.#registrations.splice(i, 1)
        removed = true
      }
    }
    if (removed) {
      this.#revision++
    }
    return removed
  }

  get size(): number {
    return this.#registrations.length
  }

  /**
   * Advances whenever a source is added or removed. Registering a source is itself a change worth resolving
   * for — even when every source in the registry, old and new, is one that can never reload.
   */
  get revision(): number {
    return this.#revision
  }

  /**
   * The providers in resolution order: priority descending, registration order ascending within a band. The
   * result is memoized against a mutation counter, so a refresh that changed nothing does not re-sort.
   */
  resolved(): readonly ConfigProvider[] {
    if (this.#cache !== undefined && this.#cachedRevision === this.#revision) {
      return this.#cache
    }

    const sorted = [...this.#registrations].sort((a, b) => b.priority - a.priority || a.seq - b.seq)

    this.#cache = sorted.map(r => r.provider)
    this.#cachedRevision = this.#revision
    return this.#cache
  }
}
