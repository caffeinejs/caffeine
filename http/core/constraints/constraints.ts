/** What a {@link ConstraintStrategy} reads a request through. The engine derives before the request is routed. */
export interface ConstraintRequest {
  /** A request header by name, in any case; several lines of one name are joined with `, `. */
  header(name: string): string | undefined
}

export interface ConstraintStrategy<T = string> {
  /**
   * The name a route declares the constraint under: `@Constraint(name, value)` / `constraint(name, value)`. A
   * JavaScript identifier, such as `tenant`: the default matcher refuses any other with `ErrConfiguration`.
   */
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

  /**
   * Reads the constraint value off the request, through its headers. Returns `undefined` when the request carries
   * none. On the web-standards engine a throw fails the request: it is answered as an error.
   */
  deriveConstraint(req: ConstraintRequest): T | undefined
}

/** The handler store a {@link ConstraintStrategy} keeps, one entry per distinct constraint value. */
export interface ConstraintStorage<T = string> {
  get(value: T): unknown
  set(value: T, handler: unknown): void
  del?(value: T): void
  empty?(): void
}
