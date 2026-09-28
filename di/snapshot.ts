import { Binding } from './binding.js'
import { InjectionToken } from './key.js'
import type { Module, ModuleFn } from './module.js'

/**
 * A binding declared with `bind()`, `rebind()` or `aspect()` before the container compiled.
 */
export interface Declaration {
  readonly key: InjectionToken
  readonly binding: Binding
  /**
   * Whether it was declared with `rebind()`, which replaces whatever else ends up under the key.
   */
  readonly rebind: boolean
}

/**
 * What a {@link Snapshot} is made of.
 */
export interface SnapshotState {
  readonly declarations: ReadonlyArray<Declaration>
  readonly modules: ReadonlyArray<Module | ModuleFn>
  readonly profiles: ReadonlyArray<string>
  readonly decorators: boolean
  readonly values?: unknown
}

/**
 * What a {@link Container} was told to hold: the bindings declared by hand, its modules, its profiles, whether it
 * registers decorated bindings, and the values bound with `bindConfig()`.
 *
 * It is not the registry. Restored into another container, the declarations are replayed and that container
 * registers the decorated bindings, runs the modules and decides profiles and conditions itself, when it compiles.
 * So a snapshot taken before `init()` and one taken after restore to the same bindings.
 *
 * Designed for testing purposes.
 */
export class Snapshot {
  readonly #state: SnapshotState

  constructor(state: SnapshotState) {
    this.#state = state
  }

  /**
   * The number of declarations.
   */
  get size(): number {
    return this.#state.declarations.length
  }

  get modules(): ReadonlyArray<Module | ModuleFn> {
    return this.#state.modules
  }

  get profiles(): ReadonlyArray<string> {
    return this.#state.profiles
  }

  /**
   * Whether the container registers decorated bindings when it compiles.
   */
  get decorators(): boolean {
    return this.#state.decorators
  }

  /**
   * The values bound with `bindConfig()` when the snapshot was taken, or `undefined` when none were.
   */
  get values(): unknown {
    return this.#state.values
  }

  /**
   * The bindings declared by hand, in the order they were declared.
   */
  declarations(): ReadonlyArray<Declaration> {
    return this.#state.declarations
  }
}
