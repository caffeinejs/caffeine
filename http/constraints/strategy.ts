import type { IncomingMessage } from 'node:http'

export interface ConstraintStrategy<T = string> {
  /** The name a route declares the constraint under: `@Constraint(name, value)` / `constraint(name, value)`. */
  readonly name: string

  /**
   * Whether a route that declares no value for this constraint is excluded once a request derives one. Fastify's
   * built-in `version` behaves this way. Leave it unset for a constraint an unconstrained route may still match.
   */
  readonly mustMatchWhenDerived?: boolean

  /** Builds the per-value handler store the router indexes routes into. */
  storage(): ConstraintStorage<T>

  /** Rejects an unusable value while the route is registered. */
  validate?(value: unknown): void

  /** Reads the constraint value off the request. Returns `undefined` when the request carries none. */
  deriveConstraint(req: IncomingMessage): T | undefined
}

/** The handler store a {@link ConstraintStrategy} keeps, one entry per distinct constraint value. */
export interface ConstraintStorage<T = string> {
  get(value: T): unknown
  set(value: T, handler: unknown): void
  del?(value: T): void
  empty?(): void
}
