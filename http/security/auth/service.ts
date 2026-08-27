import type { Provider } from '@caffeinejs/di'
import type { Context } from '../../context.js'
import type { PrincipalMapper } from '../index.js'
import { ErrAuthSchemeNotFound } from './errors.js'
import type { AuthenticationHandler } from './handler.js'
import type { AuthenticationSchemeProvider } from './scheme_provider.js'
import { AuthenticateResult, type AuthenticationProperties, AuthenticationTicket } from './ticket.js'

export class AuthenticationService {
  readonly #schemeProvider: AuthenticationSchemeProvider
  readonly #mapper: Provider<PrincipalMapper> | undefined

  /**
   * Memoises `authenticate()` per request, per scheme.
   *
   * A request authenticates more than once by design: the router-level hook runs the default scheme, a
   * route naming its own schemes re-authenticates with those, and a controller holding this service can
   * ask again. Without a memo each of those is a fresh verification — a fresh JWKS lookup, a fresh store
   * round-trip — and, worse, a fresh run of whatever side effects a handler performs while reading a
   * credential. The cookie scheme's durable remember-me rotates a single-use token inside
   * `authenticate()`, so the second call of a request would present the token the first call had just
   * invalidated and the guard would read its own rotation as theft.
   *
   * Handlers are singletons, so the memo is keyed by `Context` — one instance per request, assigned once
   * by the adapter. A `WeakMap` means the entry dies with the request rather than being something to
   * clean up.
   *
   * The *promise* is cached, not the result, so concurrent callers within one request coalesce onto a
   * single in-flight verification instead of racing. A rejection is cached with the same reasoning: a
   * failing scheme must fail identically for every caller in the request.
   */
  readonly #inflight: WeakMap<Context, Map<string, Promise<AuthenticateResult>>> = new WeakMap()

  /**
   * The same results once they have settled, readable without awaiting.
   *
   * `challenge()` is synchronous with respect to authentication — it must not start one — but it wants the
   * failure the authenticate pass already produced so it can name it in `WWW-Authenticate`. Recording the
   * settled value alongside the promise is what makes that readable after the fact.
   */
  readonly #settled: WeakMap<Context, Map<string, AuthenticateResult>> = new WeakMap()

  constructor(
    schemeProvider: AuthenticationSchemeProvider,
    mapper?: Provider<PrincipalMapper>,
  ) {
    this.#schemeProvider = schemeProvider
    this.#mapper = mapper
  }

  authenticate(ctx: Context, scheme: string): Promise<AuthenticateResult> {
    let perRequest = this.#inflight.get(ctx)
    if (perRequest === undefined) {
      perRequest = new Map()
      this.#inflight.set(ctx, perRequest)
    }

    let pending = perRequest.get(scheme)
    if (pending === undefined) {
      pending = this.#authenticate(ctx, scheme)
      perRequest.set(scheme, pending)
    }

    return pending
  }

  async #authenticate(ctx: Context, scheme: string): Promise<AuthenticateResult> {
    // An unregistered name used to come back as `none()` — indistinguishable from "the caller presented no
    // credential". A typo in a route's `schemes` therefore produced a blanket 401 with nothing to point at,
    // and on a route whose policy does not demand an identity it admitted the caller anonymously instead.
    const handler = this.#handlerFor(scheme).get()
    const result = await handler.authenticate(ctx)

    const mapped = result.succeeded && this.#mapper !== undefined
      ? AuthenticateResult.success(new AuthenticationTicket(
          await this.#mapper.get()(ctx, result.ticket!.principal),
          scheme,
          result.ticket?.properties,
        ))
      : result

    let settled = this.#settled.get(ctx)
    if (settled === undefined) {
      settled = new Map()
      this.#settled.set(ctx, settled)
    }
    settled.set(scheme, mapped)

    return mapped
  }

  challenge(ctx: Context, schemeName?: string, properties?: AuthenticationProperties): Promise<void> {
    const name = schemeName ?? this.#schemeProvider.defaultChallengeScheme
    return this.#handlerFor(name).get().challenge(ctx, properties)
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
    return this.#settled.get(ctx)?.get(scheme)
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
