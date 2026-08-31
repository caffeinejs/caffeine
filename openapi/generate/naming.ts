import type { Route, Router } from '@caffeinejs/http'

/**
 * A route group's base name: its name with a trailing `Controller` removed.
 *
 * `PetsController` becomes `Pets`, which is both the default tag and the first half of the default
 * operationId. The suffix carries no information a reader of the document needs.
 */
export function routerBaseName(router: Router<unknown>): string {
  return router.name.replace(/Controller$/, '') || router.name
}

/**
 * The default `operationId` for a route: `Pets_list`.
 *
 * Derived rather than authored so every operation has one without ceremony, and prefixed with the group
 * so two groups may each have a `list`. It is deliberately stable and boring: an operationId is part of
 * the published contract once a client has been generated from it, so `@Operation({ operationId })` is how a
 * route pins a name that outlives a class rename.
 */
export function defaultOperationId(router: Router<unknown>, route: Route<unknown>): string {
  return `${routerBaseName(router)}_${String(route.name)}`
}

/** Where an operation is defined, for error messages: `PetsController.list`. */
export function operationSite(router: Router<unknown>, route: Route<unknown>): string {
  return `${router.name}.${String(route.name)}`
}
