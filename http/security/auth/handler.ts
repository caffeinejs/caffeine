import type { Context } from '../../context.js'
import type { AuthenticateResult, AuthenticationTicket } from './ticket.js'

export interface AuthenticationHandler {
  authenticate(ctx: Context): Promise<AuthenticateResult>
  challenge(ctx: Context, properties?: object): Promise<void>
  forbid(ctx: Context, properties?: object): Promise<void>
  persist(ctx: Context, ticket: AuthenticationTicket): Promise<void>
  revoke(ctx: Context, properties?: object): Promise<void>
}

export abstract class BaseAuthenticationHandler<TOptions> implements AuthenticationHandler {
  readonly #options: TOptions

  constructor(options: TOptions) {
    this.#options = options as unknown as TOptions
  }

  get options(): TOptions {
    return this.#options
  }

  abstract authenticate(ctx: Context): Promise<AuthenticateResult>

  async challenge(ctx: Context): Promise<void> {
    ctx.status(401)
  }

  async forbid(ctx: Context): Promise<void> {
    ctx.status(403)
  }

  persist(_ctx: Context, _ticket: AuthenticationTicket): Promise<void> {
    return Promise.resolve()
  }

  revoke(_ctx: Context): Promise<void> {
    return Promise.resolve()
  }
}
