import type { ConstraintStrategy } from './strategy.js'

/** The constraint name API-version selection writes under, shared by `@Version`, `.version()` and the registry. */
export const VERSION_CONSTRAINT = 'version'

/** The request header find-my-way's built-in `version` strategy reads. */
export const kVersionHeader = 'Accept-Version'

/** One constraint the application knows about: its name, the header it reads, and its strategy when custom. */
export interface RegisteredConstraint {
  name: string
  /** The request header the strategy reads, when it reads one. Drives `Vary` and the OpenAPI header parameter. */
  header?: string
  /** The strategy to install with `addConstraintStrategy`. Unset for `version`, which Fastify ships. */
  strategy?: ConstraintStrategy
}

/**
 * The constraint names an application accepts on a route, resolved once and bound under {@link kConstraintRegistry}.
 *
 * Always holds `version` — Fastify's built-in semver matcher, reading `Accept-Version`. An application adds more
 * with `app.constraints(c => c.register(strategy))`.
 */
export class ConstraintRegistry {
  readonly #byName = new Map<string, RegisteredConstraint>()

  constructor(entries: readonly RegisteredConstraint[] = []) {
    this.#byName.set(VERSION_CONSTRAINT, { name: VERSION_CONSTRAINT, header: kVersionHeader })
    for (const entry of entries) {
      this.#byName.set(entry.name, entry)
    }
  }

  has(name: string): boolean {
    return this.#byName.has(name)
  }

  get(name: string): RegisteredConstraint | undefined {
    return this.#byName.get(name)
  }

  names(): string[] {
    return [...this.#byName.keys()]
  }

  /** The custom strategies to install with `addConstraintStrategy`. `version` has none — Fastify ships it. */
  strategies(): ConstraintStrategy[] {
    return [...this.#byName.values()]
      .map(entry => entry.strategy)
      .filter((strategy): strategy is ConstraintStrategy => strategy !== undefined)
  }
}
