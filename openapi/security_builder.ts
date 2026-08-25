import type { OpenAPISecurityOptions } from './options.js'

/**
 * Configures who may read the document.
 *
 * Authentication itself is configured the usual way, with `.authentication(...)`; this only references what
 * is already there by name. That keeps one declaration of each scheme rather than a second copy living in the
 * documentation configuration.
 */
export class OpenAPISecurityBuilder {
  #schemes: string[] = []
  #roles: string[] = []
  #policy: string[] = []

  /**
   * Which authentication schemes may satisfy the requirement, by the names given to `.authentication(...)`.
   * An unknown name fails at boot rather than silently matching nothing.
   *
   * Naming a scheme selects which one authenticates and issues the challenge. It never *replaces* the
   * requirement to be authenticated — see {@link build}.
   */
  schemes(...names: string[]): this {
    this.#schemes.push(...names)
    return this
  }

  /** Roles the caller must hold, on top of being authenticated. */
  roles(...names: string[]): this {
    this.#roles.push(...names)
    return this
  }

  /** Named authorization policies the caller must satisfy, registered via `.authorization(...)`. */
  policy(...names: string[]): this {
    this.#policy.push(...names)
    return this
  }

  /**
   * The resolved options.
   *
   * Always carries the authenticated-user requirement, which is what an empty options object means to the
   * routing layer — `schemes` states no requirement of its own, so a configuration carrying only schemes
   * would otherwise compile to a policy that admits everyone. Documentation naming an auth scheme must never
   * be the thing that publishes a secured API's shape to anonymous callers.
   */
  build(): OpenAPISecurityOptions {
    return {
      ...(this.#schemes.length > 0 ? { schemes: [...this.#schemes] } : {}),
      ...(this.#roles.length > 0 ? { roles: [...this.#roles] } : {}),
      ...(this.#policy.length > 0 ? { policy: [...this.#policy] } : {}),
    }
  }
}
