import type { Provider } from '@caffeinejs/di'

import type { Context } from '../../context.js'
import type { PrincipalMapper } from '../index.js'
import { AuthenticationState, type SchemeAuthentication } from './authentication_state.js'
import { ErrAuthSchemeNotFound } from './errors.js'
import { ForwardAuthenticationHandler } from './forward/forward.js'
import type { AuthenticationHandler } from './handler.js'
import type { AuthenticationSchemeProvider } from './scheme_provider.js'
import { AuthenticateResult, type AuthenticationProperties, AuthenticationTicket } from './ticket.js'

export class AuthenticationService {
  readonly #schemeProvider: AuthenticationSchemeProvider
  readonly #mapper: Provider<PrincipalMapper> | undefined

  constructor(schemeProvider: AuthenticationSchemeProvider, mapper?: Provider<PrincipalMapper>) {
    this.#schemeProvider = schemeProvider
    this.#mapper = mapper
  }

  /**
   * Authenticates the request with `scheme`, once.
   *
   * A request authenticates more than once by design: the router-level hook runs the default scheme, a
   * route naming its own schemes re-authenticates with those, and a controller holding this service can
   * ask again. Without a memo each of those is a fresh verification — a fresh JWKS lookup, a fresh store
   * round-trip — and, worse, a fresh run of whatever side effects a handler performs while reading a
   * credential. The cookie scheme's durable remember-me rotates a single-use token inside
   * `authenticate()`, so the second call of a request would present the token the first call had just
   * invalidated and the guard would read its own rotation as theft.
   *
   * This service is a singleton, so what a scheme did is recorded on the request — `ctx.auth` — and lives
   * exactly as long as it. The *promise* is kept, not the result, so concurrent callers within one request
   * coalesce onto a single in-flight verification instead of racing. A rejection is kept with the same
   * reasoning: a failing scheme must fail identically for every caller in the request.
   */
  authenticate(ctx: Context, scheme: string): Promise<AuthenticateResult> {
    const entry = (ctx.auth ??= new AuthenticationState()).for(scheme)
    return (entry.pending ??= this.#authenticate(ctx, scheme, entry))
  }

  async #authenticate(ctx: Context, scheme: string, entry: SchemeAuthentication): Promise<AuthenticateResult> {
    // An unregistered name used to come back as `none()` — indistinguishable from "the caller presented no
    // credential". A typo in a route's `schemes` therefore produced a blanket 401 with nothing to point at,
    // and on a route whose policy does not demand an identity it admitted the caller anonymously instead.
    const handler = this.#handlerFor(scheme).get()
    const result = await handler.authenticate(ctx)

    // What a forwarding scheme hands back is what the scheme it picked decided, which came through here already.
    const mapped =
      result.succeeded && this.#mapper !== undefined && !(handler instanceof ForwardAuthenticationHandler)
        ? AuthenticateResult.success(
            new AuthenticationTicket(
              await this.#mapper.get()(ctx, result.ticket!.principal),
              scheme,
              result.ticket?.properties,
            ),
          )
        : result

    entry.result = mapped

    return mapped
  }

  /**
   * Challenges with `schemeName`, handing the scheme back whatever it already decided for this request.
   *
   * A scheme that rejected a credential can then say why — the reason travels in the `AuthenticateResult` it
   * returned, not in state the scheme keeps for itself. Nothing is authenticated here: a scheme that has not
   * run is challenged with nothing to fault.
   */
  challenge(ctx: Context, schemeName?: string, properties?: AuthenticationProperties): Promise<void> {
    const name = schemeName ?? this.#schemeProvider.defaultChallengeScheme
    return this.#handlerFor(name).get().challenge(ctx, properties, this.resultFor(ctx, name))
  }

  forbid(ctx: Context, schemeName?: string, properties?: AuthenticationProperties): Promise<void> {
    const name = schemeName ?? this.#schemeProvider.defaultForbidScheme
    return this.#handlerFor(name).get().forbid(ctx, properties)
  }

  // `schemeName` is optional so the documented fallback to the default authenticate scheme is reachable:
  // it was declared required while the body already coalesced it, making the `??` dead and the default
  // unusable without passing `undefined` past a type that forbade it. `challenge`/`forbid` had it right.
  persist(ctx: Context, schemeName: string | undefined, ticket: AuthenticationTicket): Promise<void> {
    const name = schemeName ?? this.#schemeProvider.defaultAuthenticateScheme
    return this.#handlerFor(name).get().persist(ctx, ticket)
  }

  revoke(ctx: Context, schemeName?: string, properties?: AuthenticationProperties): Promise<void> {
    const name = schemeName ?? this.#schemeProvider.defaultAuthenticateScheme
    return this.#handlerFor(name).get().revoke(ctx, properties)
  }

  /**
   * The result a scheme already produced for this request, if it has run.
   *
   * Readable without awaiting, and never starts an authentication of its own — so a caller deciding how
   * to respond to a failure can consult what already happened rather than re-running it.
   */
  resultFor(ctx: Context, scheme: string): AuthenticateResult | undefined {
    return ctx.auth?.find(scheme)?.result
  }

  /** Resolves a scheme name to its handler, or throws naming what *is* registered. */
  #handlerFor(name: string): Provider<AuthenticationHandler> {
    const scheme = this.#schemeProvider.schemeFor(name)
    if (!scheme) {
      throw new ErrAuthSchemeNotFound(name, this.#schemeProvider.schemeNames)
    }

    return scheme
  }
}
