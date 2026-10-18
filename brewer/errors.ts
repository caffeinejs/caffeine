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

/**
 * A path parameter's value is `.` or `..`, or a wildcard holds one as a part.
 *
 * The URL standard resolves either as a step along the path, percent-encoded or not, so the request would reach
 * another route than the one the call names.
 */
export class ErrBrewPathValue extends ErrBrew {
  override readonly code = 'ERR_BREW_PATH_VALUE'

  constructor(path: string, param: string, value: string) {
    super(
      errMessage(
        `Cannot build a request for "${path}": path parameter "${param}" is "${value}", which a URL resolves as a step along the path`,
      )
        .solutions('Refuse the value before the call, or send it in the query or the body')
        .reference('@caffeinejs/brewer', ErrBrewPathValue)
        .build(),
    )
    this.name = 'ErrBrewPathValue'
  }
}
