import type { IContext } from '../../../context.js'
import type { AuthenticateResult, AuthenticationProperties, AuthenticationTicket } from './ticket.js'

export interface AuthenticationHandler {
  authenticate(ctx: IContext): Promise<AuthenticateResult>

  /**
   * Answers a caller the route did not admit, advertising what this scheme accepts.
   *
   * @param previous - What this scheme decided earlier in the same request, when it ran. A handler that can
   * say *why* it is challenging reads it from here; it never re-authenticates to find out. `undefined` means
   * the scheme has not run for this request, so there is nothing to fault.
   */
  challenge(ctx: IContext, properties?: AuthenticationProperties, previous?: AuthenticateResult): Promise<void>
  forbid(ctx: IContext, properties?: AuthenticationProperties): Promise<void>
  persist(ctx: IContext, ticket: AuthenticationTicket): Promise<void>

  /** Ends the session this scheme keeps here. Nothing leaves this application, and the request is not answered. */
  revoke(ctx: IContext, properties?: AuthenticationProperties): Promise<void>

  /**
   * Signs the user out everywhere the scheme reaches: the session here, as {@link revoke} does, and then the one at
   * an identity provider when the scheme signed the user in through one.
   *
   * It may answer the request — a provider is left by sending the browser there — so call it last. A scheme with
   * nowhere else to sign out of does what {@link revoke} does.
   */
  signOut(ctx: IContext, properties?: AuthenticationProperties): Promise<void>
}

export abstract class BaseAuthenticationHandler<TOptions> implements AuthenticationHandler {
  readonly #options: TOptions

  constructor(options: TOptions) {
    this.#options = options
  }

  get options(): TOptions {
    return this.#options
  }

  abstract authenticate(ctx: IContext): Promise<AuthenticateResult>

  async challenge(
    ctx: IContext,
    _properties?: AuthenticationProperties,
    _previous?: AuthenticateResult,
  ): Promise<void> {
    ctx.status(401)
  }

  async forbid(ctx: IContext, _properties?: AuthenticationProperties): Promise<void> {
    ctx.status(403)
  }

  persist(_ctx: IContext, _ticket: AuthenticationTicket): Promise<void> {
    return Promise.resolve()
  }

  revoke(_ctx: IContext, _properties?: AuthenticationProperties): Promise<void> {
    return Promise.resolve()
  }

  signOut(ctx: IContext, properties?: AuthenticationProperties): Promise<void> {
    return this.revoke(ctx, properties)
  }
}
