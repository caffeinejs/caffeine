import { Binding } from './binding.js'
import { Key } from './key.js'

/**
 * Represents the {@link Container} state at a specific point in time.
 * Designed for testing purposes.
 *
 * @testing
 */
export class Snapshot {
  readonly #entries: ReadonlyArray<[Key, Binding]>

  constructor(entries: ReadonlyArray<[Key, Binding]>) {
    this.#entries = entries
  }

  get size(): number {
    return this.#entries.length
  }

  entries(): ReadonlyArray<[Key, Binding]> {
    return this.#entries
  }

  filter(predicate: (key: Key, binding: Binding) => boolean): Snapshot {
    return new Snapshot(this.#entries.filter(([k, b]) => predicate(k, b)))
  }

  exclude(...keys: Key[]): Snapshot {
    const excluded = new Set<Key>(keys)
    return new Snapshot(this.#entries.filter(([k]) => !excluded.has(k)))
  }
}
