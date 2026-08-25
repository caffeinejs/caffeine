import type { Context } from '../../../context.js'
import { parseAuthorizationHeader } from '../authorization_header.js'
import { BaseAuthenticationHandler } from '../handler.js'
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

    let decoded: string
    try {
      decoded = Buffer.from(encoded, 'base64').toString('utf-8')
    } catch (e) {
      return AuthenticateResult.fail(e as Error)
    }

    const sep = decoded.indexOf(':')
    if (sep === -1) {
      return AuthenticateResult.fail(new Error('Malformed Basic credentials: missing colon separator'))
    }

    const username = decoded.slice(0, sep)
    const password = decoded.slice(sep + 1)

    try {
      const principal = await this.options.validate(ctx, username, password)
      if (!principal) {
        const err = new Error('Invalid credentials')
        await this.options.onFail?.(ctx, err)
        return AuthenticateResult.fail(err)
      }

      return AuthenticateResult.success(new AuthenticationTicket(principal, this.#name))
    } catch (e) {
      await this.options.onFail?.(ctx, e as Error)
      return AuthenticateResult.fail(e as Error)
    }
  }

  override async challenge(ctx: Context): Promise<void> {
    if (this.options.onChallenge) {
      return this.options.onChallenge(ctx)
    }

    ctx.status(401).header('WWW-Authenticate', `Basic realm="${this.options.realm ?? ''}"`)
  }

  override async forbid(ctx: Context): Promise<void> {
    if (this.options.onForbid) {
      return this.options.onForbid(ctx)
    }

    ctx.status(403)
  }
}
