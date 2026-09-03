/** Base of every error this package throws. */
export class ErrBrew extends Error {
  readonly code: string = 'ERR_BREW'

  constructor(message: string) {
    super(message)
    this.name = 'ErrBrew'
  }
}

/** A path was addressed with `$request` and a parameter it declares was not supplied. */
export class ErrBrewPathParam extends ErrBrew {
  override readonly code = 'ERR_BREW_PATH_PARAM'

  constructor(path: string, param: string) {
    super(
      `Cannot build a request for "${path}": no value for path parameter "${param}"` +
        '\nPossible Solutions:' +
        `\n  - Pass it in the request init: { params: { "${param}": value } }`,
    )
    this.name = 'ErrBrewPathParam'
  }
}
