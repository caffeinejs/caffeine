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

/** A request as an error names it: the method and the URL without its query, which can carry a credential. */
function labelOf(request: Request): string {
  const { origin, pathname } = new URL(request.url)

  return `${request.method} ${origin}${pathname}`
}

/**
 * An authenticator answered a 401 with a follow-up the client cannot send: one to another origin than the call's, or
 * one for a call whose body is a stream it read as it sent it.
 *
 * The authenticator was asked all the same, so credentials it refreshed serve the calls that follow.
 */
export class ErrBrewFollowUpNotSent extends ErrBrew {
  override readonly code = 'ERR_BREW_FOLLOW_UP_NOT_SENT'

  constructor(request: Request, problem: 'origin' | 'stream') {
    const first = `Cannot send the follow-up to the 401 from "${labelOf(request)}"`
    // Names the call's own origin only: the URL the authenticator built may carry anything.
    const message =
      problem === 'origin'
        ? errMessage(`${first}: it does not target "${new URL(request.url).origin}"`).solutions(
            'Set the credentials on the request the authenticator is given, and return that request',
          )
        : errMessage(`${first}: its body is a stream, read as it was sent`).solutions(
            'Pass the body as a function that returns the stream: { body: () => stream }',
            "Send the credentials with the first request, from the client's headers",
          )

    super(message.reference('@caffeinejs/brewer', ErrBrewFollowUpNotSent).build())
    this.name = 'ErrBrewFollowUpNotSent'
  }
}

/**
 * A call's follow-ups all met a 401, and the next would pass `maxFollowUps`.
 *
 * A `maxFollowUps` that is not a finite number, `NaN` or `Infinity`, allows none: the first 401 rejects with this.
 */
export class ErrBrewTooManyFollowUps extends ErrBrew {
  override readonly code = 'ERR_BREW_TOO_MANY_FOLLOW_UPS'

  constructor(request: Request, sent: number, limit: number) {
    const first = `Cannot answer the 401 to "${labelOf(request)}"`
    const message = Number.isFinite(limit)
      ? errMessage(`${first}: the call already sent ${sent} follow-ups, and maxFollowUps allows ${limit}`).solutions(
          'Return null from the authenticator once the server refuses the credentials it holds',
          'Raise maxFollowUps to the rounds the authentication scheme needs',
        )
      : errMessage(`${first}: maxFollowUps is ${limit}, and only a finite number of follow-ups is sent`).solutions(
          'Set maxFollowUps to the rounds the authentication scheme needs',
        )

    super(message.reference('@caffeinejs/brewer', ErrBrewTooManyFollowUps).build())
    this.name = 'ErrBrewTooManyFollowUps'
  }
}
