import type { Context } from '../../../context.js'
import { parseAuthorizationHeader } from '../authorization_header.js'
import { BaseAuthenticationHandler } from '../handler.js'
import { challenge } from '../internal/challenge.js'
import { AuthenticateResult, AuthenticationTicket } from '../ticket.js'
import type { BasicAuthenticationOptions } from './basic_options.js'

export class BasicAuthenticationHandler extends BaseAuthenticationHandler<BasicAuthenticationOptions> {
  readonly #name: string

  constructor(name: string, options: BasicAuthenticationOptions) {
    super(options)
    this.#name = name
  }

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
    const encoded = parseAuthorizationHeader(ctx.req.header('authorization'), 'Basic')
    if (encoded === undefined) {
      return AuthenticateResult.none()
    }

    // Decoding never throws: what is not base64 comes out as text with no colon in it, or as credentials nobody has.
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8')

    const sep = decoded.indexOf(':')
    if (sep === -1) {
      return AuthenticateResult.fail(new Error('Malformed Basic credentials: missing colon separator'))
    }

    const username = decoded.slice(0, sep)
    const password = decoded.slice(sep + 1)

    let failure: Error
    try {
      const principal = await this.options.validate(ctx, username, password)
      if (principal) {
        return AuthenticateResult.success(new AuthenticationTicket(principal, this.#name))
      }

      failure = new Error('Invalid credentials')
    } catch (e) {
      failure = e as Error
    }

    // Outside the `try`, so a hook that throws is not handed its own error to be called a second time with.
    await this.options.onFail?.(ctx, failure)

    return AuthenticateResult.fail(failure)
  }

  override async challenge(ctx: Context): Promise<void> {
    if (this.options.onChallenge) {
      return this.options.onChallenge(ctx)
    }

    // RFC 7617 §2 requires the realm, so an unset one is sent empty. §2.1: credentials are decoded as UTF-8 above,
    // and a client only knows to encode them so when the challenge says it.
    ctx
      .status(401)
      .appendHeader('WWW-Authenticate', challenge('Basic', { realm: this.options.realm ?? '', charset: 'UTF-8' }))
  }

  override async forbid(ctx: Context): Promise<void> {
    if (this.options.onForbid) {
      return this.options.onForbid(ctx)
    }

    ctx.status(403)
  }
}
