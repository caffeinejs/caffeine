import { Binding } from './binding.js'
import { InjectionToken } from './key.js'

/**
 * Represents the {@link Container} state at a specific point in time.
 * Designed for testing purposes.
 *
 * It holds the bindings the container registered, the ones it still held back for their conditions, and the profiles
 * it had active. Restored, a registered binding stays registered, and a held one is decided by the container it is
 * restored into, with those profiles active.
 */
export class Snapshot {
  readonly #entries: ReadonlyArray<[InjectionToken, Binding]>
  readonly #profiles: ReadonlySet<string>

  constructor(entries: ReadonlyArray<[InjectionToken, Binding]>, profiles: Iterable<string> = []) {
    this.#entries = entries
    this.#profiles = new Set(profiles)
  }

  get size(): number {
    return this.#entries.length
  }

  /**
   * The profiles active in the container the snapshot was taken from.
   */
  get profiles(): ReadonlySet<string> {
    return this.#profiles
  }

  entries(): ReadonlyArray<[InjectionToken, Binding]> {
    return this.#entries
  }

  filter(predicate: (key: InjectionToken, binding: Binding) => boolean): Snapshot {
    return new Snapshot(
      this.#entries.filter(([k, b]) => predicate(k, b)),
      this.#profiles,
    )
  }

  exclude(...keys: InjectionToken[]): Snapshot {
    const excluded = new Set<InjectionToken>(keys)
    return new Snapshot(
      this.#entries.filter(([k]) => !excluded.has(k)),
      this.#profiles,
    )
  }
}
