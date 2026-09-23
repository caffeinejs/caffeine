/**
 * What a package annotates a route with, keyed by a namespace that package owns.
 *
 * Empty here on purpose. A package that annotates routes augments this interface with its own field, so a
 * reader gets the real type instead of an `unknown` it has to cast:
 *
 * ```ts
 * declare module '@caffeinejs/http' {
 *   interface RouteDetail {
 *     openapi?: OperationDetail
 *   }
 * }
 * ```
 *
 * Routing carries the value through untouched, which is what lets a package describe a route without this
 * one knowing the package exists.
 */
export interface RouteDetail {
  /** The one namespace this package owns. See {@link RouteGroupDetail.http}. */
  http?: {
    /**
     * The route is served by the framework or a feature on the application's behalf and is not part of the
     * application's API: a single-page application's shell, for one. A reader that describes the
     * application's routes skips it.
     */
    internal?: boolean
  }
}

/**
 * The group-level counterpart of {@link RouteDetail}.
 *
 * Group detail describes the group itself and is never merged down into its routes — a reader that wants both
 * reads the two levels separately. A group nested inside another does inherit, which is the one merge
 * `inheritGroupSpec` performs.
 */
export interface RouteGroupDetail {
  /**
   * The one namespace this package owns. `internal` marks a group the framework or a feature registered on
   * the application's behalf, which a reader describing the application's API skips; `@caffeinejs/openapi`
   * honours it the way it honours its own `openapi.hidden`.
   */
  http?: {
    internal?: boolean
  }
}
