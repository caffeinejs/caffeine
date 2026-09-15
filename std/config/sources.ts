import type { ConfigProvider } from './config.js'

/**
 * A live, ordered registry of configuration sources.
 *
 * Precedence is registration order alone: the most recently added source wins a conflicting key, so a caller
 * registers defaults/base sources first and overrides last. There is no priority argument — a source that
 * must outrank another is simply added after it.
 *
 * Live is also the point: {@link ConfigEngine} reads it on **every** resolve rather than capturing a list up
 * front, so a source added before `container.init()` lands on the first bootstrap and one added afterwards
 * lands on the next refresh. This is what lets a feature contribute its own values long after the application
 * builder ran.
 */
export class ConfigSources {
  /** A registry holding the given providers, in order — the last one wins a conflicting key. */
  static of(...providers: readonly ConfigProvider[]): ConfigSources {
    return new ConfigSources().addAll(providers)
  }

  readonly #registrations: ConfigProvider[] = []
  #revision = 0
  #cache: readonly ConfigProvider[] | undefined
  #cachedRevision = -1

  /** Registers a source. Overrides an earlier one on a conflicting key; call the override last. */
  add(provider: ConfigProvider): this {
    this.#registrations.unshift(provider)
    this.#revision++
    return this
  }

  /** Registers several sources at once, in the given order — later ones in the list win the earlier ones. */
  addAll(providers: readonly ConfigProvider[]): this {
    for (const provider of providers) {
      this.add(provider)
    }
    return this
  }

  /** Removes every source with the given id. Returns whether anything was removed. */
  remove(id: string): boolean {
    let removed = false
    for (let i = this.#registrations.length - 1; i >= 0; i--) {
      if (this.#registrations[i].id === id) {
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
   * The providers in resolution order: most recently registered first. The result is memoized against a
   * mutation counter, so a refresh that changed nothing does not re-copy it, and a caller cannot reach the
   * live internal array to mutate it.
   */
  resolved(): readonly ConfigProvider[] {
    if (this.#cache !== undefined && this.#cachedRevision === this.#revision) {
      return this.#cache
    }

    this.#cache = [...this.#registrations]
    this.#cachedRevision = this.#revision
    return this.#cache
  }
}
