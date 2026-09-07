import { flattenObject } from '../flatten.js'
import { joinPath, toPathParts } from '../path.js'
import type { ConfigEntry, ConfigProvider, ConfigValue, PropertySource, ResolutionContext } from '../types.js'

/**
 * A source whose contents can change at any time.
 *
 * Unlike {@link InlineConfigProvider}, which is a fixed snapshot handed to the constructor, this one is written to
 * after registration — which is what makes it the backing store for values that are not known when the
 * application builder runs. The framework uses one per band it owns: feature defaults land in the
 * `FRAMEWORK` band and feature builder methods in the `CODE` band.
 *
 * A write is picked up by the next resolve: before `container.init()` that is the first bootstrap, afterwards
 * it takes a `refresher.refresh(CONFIG_REFRESH_LABEL)`. Nothing observes a write in place — configuration is
 * materialized and validated as a whole, never key by key.
 */
export class MutableConfigProvider implements ConfigProvider {
  readonly id: string
  /** Writes can arrive at any time, so a refresh has to consider this source. */
  readonly reloadable = true
  readonly #origin: string
  #entries = new Map<string, ConfigEntry>()
  #revision = 0

  constructor(id = 'mutable') {
    this.id = id
    this.#origin = `mutable:${id}`
  }

  /**
   * The write counter. This is what keeps a refresh free in the common case: the framework registers one of
   * these per configuration band, and both are written before start-up and never touched again — so they
   * report an unchanged stamp and the refresh skips the whole resolve.
   */
  revision(): number {
    return this.#revision
  }

  /**
   * Sets a value at `path`, given either dotted (`'server.port'`) or pre-split (`['server', 'port']`). An
   * object or array value is flattened to its leaves, so it merges with whatever else the tree holds at that
   * path rather than replacing the subtree wholesale.
   */
  set(path: string | readonly string[], value: ConfigValue): this {
    const prefix = joinPath(toPathParts(path))
    this.#deletePrefix(prefix)
    flattenObject(value, this.#origin, prefix, this.#entries)
    this.#revision++
    return this
  }

  /** Sets every leaf of `values`, keyed from the tree root. */
  merge(values: Record<string, ConfigValue>): this {
    flattenObject(values, this.#origin, '', this.#entries)
    this.#revision++
    return this
  }

  /** Removes the value at `path` and everything beneath it. */
  unset(path: string | readonly string[]): this {
    this.#deletePrefix(joinPath(toPathParts(path)))
    this.#revision++
    return this
  }

  /** Discards everything and starts over from `values`. */
  replace(values: Record<string, ConfigValue>): this {
    this.#entries = new Map()
    flattenObject(values, this.#origin, '', this.#entries)
    this.#revision++
    return this
  }

  /** Whether this source currently contributes anything. */
  get empty(): boolean {
    return this.#entries.size === 0
  }

  async load(_ctx: ResolutionContext): Promise<PropertySource[]> {
    // Copy: the snapshot a resolve works from must not shift under it if something writes mid-flight.
    return [{ name: this.#origin, entries: new Map(this.#entries) }]
  }

  #deletePrefix(prefix: string): void {
    if (prefix === '') {
      this.#entries.clear()
      return
    }

    const nested = `${prefix}.`
    for (const key of this.#entries.keys()) {
      if (key === prefix || key.startsWith(nested)) {
        this.#entries.delete(key)
      }
    }
  }
}
