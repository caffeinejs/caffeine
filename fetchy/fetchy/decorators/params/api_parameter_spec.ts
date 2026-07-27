import type { MethodBuilder } from '../registrar/builders.js'

export interface APIParameterApplyContext {
  spec: MethodBuilder
  index: number
}

/**
 * A parameter binding, produced by a plain factory function (`Param`, `Query`, `Body`, ...) and
 * consumed positionally by `@Params([...])`. TC39 has no parameter decorators, so this is the
 * substitute extension point for binding method arguments to parts of the outgoing request.
 */
export interface APIParameterSpec {
  apply(ctx: APIParameterApplyContext): void
}
