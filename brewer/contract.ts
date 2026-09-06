/**
 * One route, as the server described it.
 *
 * Structurally identical to `@caffeinejs/http`'s `RouteDef`, and deliberately not an import of it: this package
 * runs in a browser and does not depend on the server. A route the server declares satisfies this by structural
 * typing, which is all the client needs. A type test asserts the two stay the same shape.
 */
export interface RouteContract {
  method: string
  path: string
  params: unknown
  query: unknown
  headers: unknown
  body: unknown
  output: unknown
  responses: unknown
}

/**
 * The routes carried by whatever was handed to {@link brewer}: an application, a router, or a bare union of
 * {@link RouteContract}.
 *
 * Both `brewer<typeof app>` and `brewer<RoutesOf<typeof app>>` work, and neither needs explaining — the phantom is
 * unwrapped when there is one, and the union taken as-is when there is not.
 */
export type Routes<T> = T extends { readonly __routes?: infer R }
  ? NonNullable<R> extends RouteContract
    ? NonNullable<R>
    : never
  : T extends RouteContract
    ? T
    : never
