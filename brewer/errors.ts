import { errMessage } from './_err_message.gen.js'

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
      errMessage(`Cannot build a request for "${path}": no value for path parameter "${param}"`)
        .solutions(`Pass it in the request init: { params: { "${param}": value } }`)
        .reference('@caffeinejs/brewer', ErrBrewPathParam)
        .build(),
    )
    this.name = 'ErrBrewPathParam'
  }
}
