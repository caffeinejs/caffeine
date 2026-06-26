export class ErrNoRoutesForController extends Error {
  readonly code = 'ERR_NO_ROUTES_FOR_CONTROLLER'
  readonly name = 'ErrNoRoutesForController'

  constructor(controllerName: string) {
    super(`Cannot build test client: no routes found for controller "${controllerName}"`)
  }
}
