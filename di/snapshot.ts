import { Binding } from './binding.js'
import { InjectionToken } from './key.js'

/**
 * Represents the {@link Container} state at a specific point in time.
 * Designed for testing purposes.
 */
export class Snapshot {
  readonly #entries: ReadonlyArray<[InjectionToken, Binding]>

  constructor(entries: ReadonlyArray<[InjectionToken, Binding]>) {
    this.#entries = entries
  }

  get size(): number {
    return this.#entries.length
  }

  entries(): ReadonlyArray<[InjectionToken, Binding]> {
    return this.#entries
  }

  filter(predicate: (key: InjectionToken, binding: Binding) => boolean): Snapshot {
    return new Snapshot(this.#entries.filter(([k, b]) => predicate(k, b)))
  }

  exclude(...keys: InjectionToken[]): Snapshot {
    const excluded = new Set<InjectionToken>(keys)
    return new Snapshot(this.#entries.filter(([k]) => !excluded.has(k)))
  }
}
