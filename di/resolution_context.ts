import { Key } from './key.js'
import { Binding } from './binding.js'
import { ContainerOps } from './container_interface.js'

/**
 * ResolutionContext is a context object passed to many components.
 * One example is the {@link Factory} function.
 * It provides key information to resolve or build dependencies.
 */
export interface ResolutionContext {
  /**
   * Expose {@link Container} operations.
   *
   * @readonly
   */
  readonly container: ContainerOps

  /**
   * The {@link Key} of the binding.
   *
   * @readonly
   */
  readonly key: Key<unknown>

  /**
   * The {@link Binding} instance.
   *
   * @readonly
   */
  readonly binding: Binding<any>
}
