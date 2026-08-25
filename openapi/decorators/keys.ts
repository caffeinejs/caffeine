/**
 * Route-level key under which `@Operation` stores its {@link OperationDetail} in `RouteSpec.extras`.
 *
 * `extras` is the extension slot http already carries through routing untouched, which is what lets this
 * package annotate routes without http knowing OpenAPI exists.
 */
export const kOperation = Symbol.for('@caffeinejs/openapi:operation')

/** Router-level key under which `@APIGroup` stores its {@link APIGroupDetail} in `RouterSpec.extras`. */
export const kAPIGroup = Symbol.for('@caffeinejs/openapi:api_group')
