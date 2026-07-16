import { Context } from '../../../context.js'
import type { AuthenticationHandler } from '../handler.js'
import { AuthenticationSchemeProvider } from '../scheme_provider.js'
import { AuthenticateResult, AuthenticationTicket } from '../ticket.js'

export type AuthenticationHandlerSelector
  = (ctx: Context, scheme: string) => Promise<string> | string

export class ForwardAuthenticationHandler implements AuthenticationHandler {
  readonly #selector: AuthenticationHandlerSelector
  #schemeProvider!: AuthenticationSchemeProvider

  constructor(selector: AuthenticationHandlerSelector) {
    this.#selector = selector
  }

  setSchemeProvider(schemeProvider: AuthenticationSchemeProvider): void {
    this.#schemeProvider = schemeProvider
  }

  authenticate(ctx: Context): Promise<AuthenticateResult> {
    return this.#selectScheme(ctx).then(handler => handler.authenticate(ctx))
  }

  challenge(ctx: Context, properties?: object): Promise<void> {
    return this.#selectScheme(ctx).then(handler => handler.challenge(ctx, properties))
  }

  forbid(ctx: Context, properties?: object): Promise<void> {
    return this.#selectScheme(ctx).then(handler => handler.forbid(ctx, properties))
  }

  persist(ctx: Context, ticket: AuthenticationTicket): Promise<void> {
    return this.#selectScheme(ctx).then(handler => handler.persist(ctx, ticket))
  }

  revoke(ctx: Context, properties?: object): Promise<void> {
    return this.#selectScheme(ctx).then(handler => handler.revoke(ctx, properties))
  }

  async #selectScheme(ctx: Context): Promise<AuthenticationHandler> {
    const scheme = await Promise.resolve(this.#selector(ctx, this.#schemeProvider.defaultAuthenticateScheme))
    if (!scheme) {
      throw new Error('No scheme selected.')
    }

    const handler = this.#schemeProvider.schemeFor(scheme)
    if (!handler) {
      throw new Error('No handler found for scheme.')
    }

    return handler.get()
  }
}
