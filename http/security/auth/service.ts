import type { Provider } from '@caffeinejs/core'
import type { Context } from '../../context.js'
import type { PrincipalMapper } from '../principal.js'
import type { AuthenticationSchemeProvider } from './scheme_provider.js'
import { AuthenticateResult, AuthenticationProperties, AuthenticationTicket } from './ticket.js'

export class AuthenticationCoordinator {
  readonly #schemeProvider: AuthenticationSchemeProvider
  readonly #mapper: Provider<PrincipalMapper> | undefined

  constructor(
    schemeProvider: AuthenticationSchemeProvider,
    mapper?: Provider<PrincipalMapper>,
  ) {
    this.#schemeProvider = schemeProvider
    this.#mapper = mapper
  }

  async authenticate(ctx: Context, scheme: string): Promise<AuthenticateResult> {
    const wrapped = this.#schemeProvider.schemeFor(scheme)
    if (!wrapped) {
      return AuthenticateResult.none()
    }

    const handler = wrapped.get()
    const result = await handler.authenticate(ctx)

    if (result.succeeded && this.#mapper !== undefined) {
      const principal = await this.#mapper.get()(ctx, result.ticket!.principal)

      return AuthenticateResult.success(new AuthenticationTicket(principal, scheme, result.ticket?.properties))
    }

    return result
  }

  challenge(
    ctx: Context,
    schemeName?: string,
    properties?: AuthenticationProperties,
  ): Promise<void> {
    const name = schemeName ?? this.#schemeProvider.defaultAuthenticateScheme
    const scheme = this.#schemeProvider.schemeFor(name)
    if (!scheme) {
      throw new Error(`Scheme ${name} not found`)
    }

    return scheme.get().challenge(ctx, properties)
  }

  forbid(
    ctx: Context,
    schemeName?: string,
    properties?: AuthenticationProperties,
  ): Promise<void> {
    const name = schemeName ?? this.#schemeProvider.defaultAuthenticateScheme
    const scheme = this.#schemeProvider.schemeFor(name)
    if (!scheme) {
      throw new Error(`Scheme ${name} not found`)
    }

    return scheme.get().forbid(ctx, properties)
  }

  persist(
    ctx: Context,
    schemeName: string,
    ticket: AuthenticationTicket,
  ): Promise<void> {
    const name = schemeName ?? this.#schemeProvider.defaultAuthenticateScheme
    const scheme = this.#schemeProvider.schemeFor(name)
    if (!scheme) {
      throw new Error(`Scheme ${name} not found`)
    }

    return scheme.get().persist(ctx, ticket)
  }

  revoke(
    ctx: Context,
    schemeName: string,
    properties?: AuthenticationProperties,
  ): Promise<void> {
    const name = schemeName ?? this.#schemeProvider.defaultAuthenticateScheme
    const scheme = this.#schemeProvider.schemeFor(name)
    if (!scheme) {
      throw new Error(`Scheme ${name} not found`)
    }

    return scheme.get().revoke(ctx, properties)
  }
}
