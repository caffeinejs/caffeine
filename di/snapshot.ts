import { Binding } from './binding.js'
import { InjectionToken } from './key.js'

/**
 * Represents the {@link Container} state at a specific point in time: its bindings, and the values bound with
 * `bindValuesProvider()`.
 * Designed for testing purposes.
 */
export class Snapshot {
  readonly #entries: ReadonlyArray<[InjectionToken, Binding]>
  readonly #values: unknown

  constructor(entries: ReadonlyArray<[InjectionToken, Binding]>, values?: unknown) {
    this.#entries = entries
    this.#values = values
  }

  get size(): number {
    return this.#entries.length
  }

  /**
   * The values bound with `bindValuesProvider()` when the snapshot was taken, or `undefined` when none were.
   *
   * They are not a binding, so {@link filter} and {@link exclude} keep them.
   */
  get values(): unknown {
    return this.#values
  }

  entries(): ReadonlyArray<[InjectionToken, Binding]> {
    return this.#entries
  }

  filter(predicate: (key: InjectionToken, binding: Binding) => boolean): Snapshot {
    return new Snapshot(
      this.#entries.filter(([k, b]) => predicate(k, b)),
      this.#values,
    )
  }

  exclude(...keys: InjectionToken[]): Snapshot {
    const excluded = new Set<InjectionToken>(keys)
    return new Snapshot(
      this.#entries.filter(([k]) => !excluded.has(k)),
      this.#values,
    )
  }
}
