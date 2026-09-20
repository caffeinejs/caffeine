import { Context } from '../../../context.js'
import { ErrAuthConfiguration, ErrAuthSchemeNotFound } from '../errors.js'
import type { AuthenticationHandler } from '../handler.js'
import { AuthenticationSchemeProvider } from '../scheme_provider.js'
import type { AuthenticationService } from '../service.js'
import { AuthenticateResult, type AuthenticationProperties, AuthenticationTicket } from '../ticket.js'

export type AuthenticationHandlerSelector = (ctx: Context, scheme: string) => Promise<string> | string

/**
 * A scheme that does nothing but pick another one, per request.
 *
 * The scheme it picks is authenticated through {@link AuthenticationService}, so it runs once for a request however
 * often the request reaches it — through this one, by name from a route, or from a handler asking again.
 *
 * @throws ErrAuthConfiguration when the selector names no scheme, or one that forwards as well. A selector often
 * reads the request, and one that could be talked into naming this scheme would otherwise go round for ever.
 * @throws ErrAuthSchemeNotFound when the selector names a scheme that is not registered.
 */
export class ForwardAuthenticationHandler implements AuthenticationHandler {
  readonly #selector: AuthenticationHandlerSelector
  #schemeProvider!: AuthenticationSchemeProvider
  #service!: AuthenticationService

  constructor(selector: AuthenticationHandlerSelector) {
    this.#selector = selector
  }

  setSchemeProvider(schemeProvider: AuthenticationSchemeProvider): void {
    this.#schemeProvider = schemeProvider
  }

  setService(service: AuthenticationService): void {
    this.#service = service
  }

  authenticate(ctx: Context): Promise<AuthenticateResult> {
    return this.#select(ctx).then(({ scheme }) => this.#service.authenticate(ctx, scheme))
  }

  challenge(ctx: Context, properties?: AuthenticationProperties, previous?: AuthenticateResult): Promise<void> {
    return this.#select(ctx).then(({ handler }) => handler.challenge(ctx, properties, previous))
  }

  forbid(ctx: Context, properties?: AuthenticationProperties): Promise<void> {
    return this.#select(ctx).then(({ handler }) => handler.forbid(ctx, properties))
  }

  persist(ctx: Context, ticket: AuthenticationTicket): Promise<void> {
    return this.#select(ctx).then(({ handler }) => handler.persist(ctx, ticket))
  }

  revoke(ctx: Context, properties?: AuthenticationProperties): Promise<void> {
    return this.#select(ctx).then(({ handler }) => handler.revoke(ctx, properties))
  }

  signOut(ctx: Context, properties?: AuthenticationProperties): Promise<void> {
    return this.#select(ctx).then(({ handler }) => handler.signOut(ctx, properties))
  }

  async #select(ctx: Context): Promise<{ scheme: string; handler: AuthenticationHandler }> {
    const scheme = await this.#selector(ctx, this.#schemeProvider.defaultAuthenticateScheme)
    if (!scheme) {
      throw new ErrAuthConfiguration('Cannot forward authentication: the selector returned no scheme')
    }

    const handler = this.#schemeProvider.schemeFor(scheme)?.get()
    if (!handler) {
      throw new ErrAuthSchemeNotFound(scheme, this.#schemeProvider.schemeNames)
    }

    if (handler instanceof ForwardAuthenticationHandler) {
      throw new ErrAuthConfiguration(
        `Cannot forward authentication: the selector returned "${scheme}", which forwards as well`,
      )
    }

    return { scheme, handler }
  }
}
