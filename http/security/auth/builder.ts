import { Provider, type Ctor, type Key } from '@caffeinejs/di'
import { Context } from '../../context.js'
import type { PrincipalMapper } from '../index.js'
import { kServiceConfigure, Service, ServiceKit } from '../../service.js'
import type { AuthenticationHandler } from './handler.js'
import { AuthenticationSchemeProvider } from './scheme_provider.js'
import { AuthenticationService } from './service.js'
import { BasicAuthenticationHandler } from './basic/basic.js'
import { BasicAuthenticationOptionsBuilder } from './basic/basic_options.js'
import { ForwardAuthenticationHandler } from './forward/forward.js'
import { JWTAuthenticationHandler } from './jwt/jwt.js'
import { JWTService } from './jwt/jwt_service.js'
import { jwtServiceKey } from './jwt/keys.js'
import { kAuthOpts, kOIDCMeta } from './keys.js'
import { JWTAuthenticationOptionsBuilder } from './jwt/jwt_options.js'
import { OpaqueTokenAuthenticationHandler } from './opaque/opaque.js'
import { OpaqueTokenAuthenticationOptionsBuilder } from './opaque/opaque_options.js'
import { OpaqueTokenStore } from './opaque/opaque_token_store.js'
import { CookieAuthenticationHandler } from './cookie/cookie.js'
import { CookieAuthenticationOptionsBuilder } from './cookie/cookie_options.js'
import { RememberMeTokenStore } from './cookie/remember_me_token_store.js'
import { CredentialsService, type CredentialsServiceOptions } from './credentials/credentials_service.js'
import { PasswordHasher, ScryptPasswordHasher } from './credentials/password_hasher.js'
import { UserProvider } from './credentials/user_provider.js'
import { RefreshTokenService } from './refresh/refresh_token_service.js'
import { RefreshTokenStore } from './refresh/refresh_token_store.js'
import { type RefreshTokenOptions, RefreshTokenOptionsBuilder } from './refresh/refresh_options.js'
import { GOOGLE_ISSUER, OIDCAuthenticationHandler, OIDCAuthenticationOptionsBuilder } from './oidc/index.js'
import {
  githubOAuth2Preset,
  OAuth2AuthenticationHandler,
  OAuth2AuthenticationOptionsBuilder,
} from './oauth/index.js'
import type { GithubPresetOptions } from './oauth/provider/github.js'
import type { OAuthCallbackHandler, OIDCMeta } from './oidc/index.js'

export interface AuthenticationOptions {
  defaultAuthenticateScheme: string
  defaultChallengeScheme?: string
  defaultForbidScheme?: string
}

export class AuthenticationBuilder implements Service {
  readonly #schemes: Map<string, Key<AuthenticationHandler> | AuthenticationHandler> = new Map()
  readonly #options: Partial<AuthenticationOptions>
  readonly #oidcHandlers: OAuthCallbackHandler[] = []

  #mapper: PrincipalMapper | string | symbol | undefined
  #credentials: CredentialsServiceOptions | undefined
  #refresh: RefreshTokenOptions | undefined

  constructor(options: Partial<AuthenticationOptions> = {}) {
    this.#options = options
  }

  addStrategy(name: string, handler: AuthenticationHandler): this
  addStrategy(name: string, key: Key<AuthenticationHandler>): this
  addStrategy(name: string, keyOrHandler: Key<AuthenticationHandler> | AuthenticationHandler): this {
    this.#schemes.set(name, keyOrHandler)
    return this
  }

  addJWTBearer(opts: (opts: JWTAuthenticationOptionsBuilder) => void): this
  addJWTBearer(name: string, opts: (opts: JWTAuthenticationOptionsBuilder) => void): this
  addJWTBearer(
    optsOrName: ((opts: JWTAuthenticationOptionsBuilder) => void) | string,
    options?: (opts: JWTAuthenticationOptionsBuilder) => void,
  ): this {
    const name = typeof optsOrName === 'string'
      ? optsOrName
      : 'Bearer'
    const optsFn = typeof optsOrName === 'string'
      ? options
      : optsOrName
    if (!optsFn) {
      throw new Error('Options are required')
    }

    const builder = new JWTAuthenticationOptionsBuilder()
    optsFn(builder)

    return this.addStrategy(name, new JWTAuthenticationHandler(name, builder.build()))
  }

  addBasic(opts: (opts: BasicAuthenticationOptionsBuilder) => void): this
  addBasic(name: string, opts: (opts: BasicAuthenticationOptionsBuilder) => void): this
  addBasic(
    optsOrName: ((opts: BasicAuthenticationOptionsBuilder) => void) | string,
    options?: (opts: BasicAuthenticationOptionsBuilder) => void,
  ): this {
    const name = typeof optsOrName === 'string'
      ? optsOrName
      : 'Basic'
    const optsFn = typeof optsOrName === 'string'
      ? options
      : optsOrName
    if (!optsFn) {
      throw new Error('Options are required')
    }

    const builder = new BasicAuthenticationOptionsBuilder()
    optsFn(builder)

    return this.addStrategy(name, new BasicAuthenticationHandler(name, builder.build()))
  }

  addCookie(opts: (opts: CookieAuthenticationOptionsBuilder) => void): this
  addCookie(name: string, opts: (opts: CookieAuthenticationOptionsBuilder) => void): this
  addCookie(
    optsOrName: ((opts: CookieAuthenticationOptionsBuilder) => void) | string,
    options?: (opts: CookieAuthenticationOptionsBuilder) => void,
  ): this {
    const name = typeof optsOrName === 'string'
      ? optsOrName
      : 'Cookie'
    const optsFn = typeof optsOrName === 'string'
      ? options
      : optsOrName
    if (!optsFn) {
      throw new Error('Options are required')
    }

    const builder = new CookieAuthenticationOptionsBuilder()
    optsFn(builder)

    return this.addStrategy(name, new CookieAuthenticationHandler(name, builder.build()))
  }

  /**
   * Registers the credential module: a `CredentialsService` (for login endpoints) plus a fallback
   * `PasswordHasher` (`ScryptPasswordHasher`, overridable). The user must bind a `UserProvider`
   * implementation to the container. Not a scheme — pair it with `addCookie` for session login.
   */
  addCredentials(options: CredentialsServiceOptions = {}): this {
    this.#credentials = options
    return this
  }

  addOpaqueToken(): this
  addOpaqueToken(opts: (opts: OpaqueTokenAuthenticationOptionsBuilder) => void): this
  addOpaqueToken(name: string, opts?: (opts: OpaqueTokenAuthenticationOptionsBuilder) => void): this
  addOpaqueToken(
    optsOrName?: ((opts: OpaqueTokenAuthenticationOptionsBuilder) => void) | string,
    options?: (opts: OpaqueTokenAuthenticationOptionsBuilder) => void,
  ): this {
    const name = typeof optsOrName === 'string'
      ? optsOrName
      : 'OpaqueToken'
    const optsFn = typeof optsOrName === 'string'
      ? options
      : optsOrName

    // The options callback is optional: `store` defaults to the `OpaqueTokenStore` token, so the
    // zero-arg form works once the user has bound their store to the container.
    const builder = new OpaqueTokenAuthenticationOptionsBuilder()
    optsFn?.(builder)

    return this.addStrategy(name, new OpaqueTokenAuthenticationHandler(name, builder.build()))
  }

  addOIDC(name: string, configure: (opts: OIDCAuthenticationOptionsBuilder) => void): this {
    const builder = new OIDCAuthenticationOptionsBuilder()
    configure(builder)
    const handler = new OIDCAuthenticationHandler(name, builder.build(name))
    this.#oidcHandlers.push(handler)
    return this.addStrategy(name, handler)
  }

  addOIDCGoogle(name: string, configure: (opts: OIDCAuthenticationOptionsBuilder) => void): this {
    return this.addOIDC(name, opts => {
      opts.discoveryURL(GOOGLE_ISSUER).issuer(GOOGLE_ISSUER)
      configure(opts)
    })
  }

  /**
   * Registers a plain OAuth 2.0 strategy, for providers that do not implement OpenID Connect.
   *
   * Prefer `addOIDC` wherever a provider supports it: a signed id_token is a stronger identity
   * assertion than a JSON body fetched with a bearer token.
   */
  addOAuth2(name: string, configure: (opts: OAuth2AuthenticationOptionsBuilder) => void): this {
    const builder = new OAuth2AuthenticationOptionsBuilder()
    configure(builder)
    // Raw options, not `build(name)`: the handler constructor is the single resolution point,
    // so resolving here as well would validate and default the options twice.
    const handler = new OAuth2AuthenticationHandler(name, builder.toOptions())
    this.#oidcHandlers.push(handler)
    return this.addStrategy(name, handler)
  }

  addGithub(
    name: string,
    configure: (opts: OAuth2AuthenticationOptionsBuilder) => void,
    preset: GithubPresetOptions = {},
  ): this {
    const builder = new OAuth2AuthenticationOptionsBuilder()
    configure(builder)
    // Raw options: the preset supplies the endpoints, subjectClaim and scope defaults that
    // resolution requires, so it must run before resolution, not after. `build(name)` here
    // threw "authorizationEndpoint is required" before the preset could fill them in.
    const handler = new OAuth2AuthenticationHandler(
      name,
      githubOAuth2Preset({ ...builder.toOptions(), ...preset }),
    )
    this.#oidcHandlers.push(handler)
    return this.addStrategy(name, handler)
  }

  forward(name: string, selector: (ctx: Context) => string | Promise<string>): this {
    const handler = new ForwardAuthenticationHandler(selector)
    return this.addStrategy(name, handler)
  }

  default(name: string): this {
    this.#options.defaultAuthenticateScheme = name
    return this
  }

  defaultChallenge(name: string): this {
    this.#options.defaultChallengeScheme = name
    return this
  }

  defaultForbid(name: string): this {
    this.#options.defaultForbidScheme = name
    return this
  }

  mapUser(mapper: PrincipalMapper | string | symbol): this {
    this.#mapper = mapper
    return this
  }

  /**
   * Enables the bearer refresh-token grant. Binds a {@link RefreshTokenService} (issue / refresh /
   * revoke) that signs access tokens with the default JWT scheme's shared service and persists refresh
   * tokens in the container-bound {@link RefreshTokenStore}. Requires a JWT bearer scheme.
   */
  addRefreshTokens(configure: (options: RefreshTokenOptionsBuilder) => void): this {
    const builder = new RefreshTokenOptionsBuilder()
    configure(builder)
    this.#refresh = builder.build()

    return this
  }

  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    const opts = this.#options
    const firstScheme = this.#schemes.keys().next().value as string | undefined

    const schemeCount = this.#schemes.size
    const defaultScheme = opts.defaultAuthenticateScheme ?? (schemeCount === 1 ? firstScheme : undefined)
    if (!defaultScheme) {
      throw new Error(
        schemeCount === 0
          ? 'Cannot configure authentication: no strategies are registered'
          : 'Cannot configure authentication: multiple strategies are registered and no default scheme is set',
      )
    }
    const options: AuthenticationOptions = {
      defaultAuthenticateScheme: defaultScheme,
      defaultChallengeScheme: opts.defaultChallengeScheme,
      defaultForbidScheme: opts.defaultForbidScheme,
    }

    const schemes = new Map<string, Provider<AuthenticationHandler>>()
    for (const [name, keyOrHandler] of this.#schemes) {
      const handler: Provider<AuthenticationHandler> = isConstructable(keyOrHandler)
        ? kit.container.wrap(keyOrHandler)
        : { get: () => keyOrHandler as AuthenticationHandler }
      schemes.set(name, handler)
    }

    const mapper = this.#mapper === undefined
      ? undefined
      : typeof this.#mapper === 'string' || typeof this.#mapper === 'symbol'
        ? kit.container.wrap<PrincipalMapper>(this.#mapper)
        : { get: () => this.#mapper as PrincipalMapper }
    const schemeProvider = new AuthenticationSchemeProvider(schemes, options)
    const service = new AuthenticationService(schemeProvider, mapper)

    // Iterate the raw registrations, not `schemes`: those hold Provider wrappers, and an
    // instanceof against the wrapper never matches — which left every forwarded handler
    // without a scheme provider. Reading the raw value also avoids `provider.get()`, which
    // would eagerly instantiate every container-bound handler at configure time.
    for (const keyOrHandler of this.#schemes.values()) {
      if (keyOrHandler instanceof ForwardAuthenticationHandler) {
        keyOrHandler.setSchemeProvider(schemeProvider)
      }

      // Resolve each opaque-token store to a Provider and inject it. Reading the raw registration
      // (not the wrapped `schemes` map) and deferring `.get()` keeps container-bound stores lazy,
      // exactly as the Forward wiring above does. A missing `store` defaults to the
      // `OpaqueTokenStore` abstract-class token.
      if (keyOrHandler instanceof OpaqueTokenAuthenticationHandler) {
        const store = keyOrHandler.options.store ?? OpaqueTokenStore
        const provider: Provider<OpaqueTokenStore> = isKey(store)
          ? kit.container.wrap<OpaqueTokenStore>(store)
          : { get: () => store }
        keyOrHandler.setStore(provider)
      }

      // Durable cookie remember-me needs a server-side token store and a user provider to reload the
      // user on refresh. Wrap both lazily like the stores above (a `has()` check cannot see the
      // `.extends()` polymorphic binding users register for these abstract tokens); an unbound token
      // surfaces as a resolution error the first time remember-me is used.
      if (keyOrHandler instanceof CookieAuthenticationHandler && keyOrHandler.options.rememberMe) {
        keyOrHandler.setRememberDeps(
          kit.container.wrap<RememberMeTokenStore>(RememberMeTokenStore),
          kit.container.wrap<UserProvider>(UserProvider),
        )
      }
    }

    kit.container.bind(AuthenticationService).toValue(service).internal()
    kit.container.bind(kAuthOpts).toValue(options).internal()

    // Share each JWT scheme's service (verify + sign) for injection into token-issuing controllers.
    // Every JWT scheme is reachable via its keyed token; the default JWT scheme (or the first, if the
    // default is not a JWT scheme) is also bound under the bare `JWTService` token for the common case.
    const jwtSchemes = [...this.#schemes]
      .filter((entry): entry is [string, JWTAuthenticationHandler] => entry[1] instanceof JWTAuthenticationHandler)
    for (const [name, handler] of jwtSchemes) {
      kit.container.bind(jwtServiceKey(name)).toValue(handler.service)
    }
    if (jwtSchemes.length > 0) {
      const preferred = jwtSchemes.find(([name]) => name === defaultScheme) ?? jwtSchemes[0]
      kit.container.bind(JWTService).toValue(preferred[1].service)
    }

    if (this.#credentials !== undefined) {
      // Default hasher is a fallback so a user-bound PasswordHasher wins. CredentialsService is a
      // public binding (controllers inject it); it resolves the user-bound UserProvider and the
      // PasswordHasher, and the configured options ride along in the closure (a value that is not a
      // container key, so a plain DI injection cannot carry it).
      const options = this.#credentials
      kit.container.bind(PasswordHasher).toClass(ScryptPasswordHasher).fallback()
      kit.container.bind(CredentialsService).toFunction(
        (provider: UserProvider, hasher: PasswordHasher) => new CredentialsService(provider, hasher, options),
        [UserProvider, PasswordHasher],
      )
    }

    if (this.#refresh !== undefined) {
      if (jwtSchemes.length === 0) {
        throw new Error(
          'Cannot configure refresh tokens: no JWT scheme is registered (add a JWT bearer scheme via addJWTBearer)',
        )
      }

      // Signs with the shared (default) JWTService bound above and persists in the user-bound
      // RefreshTokenStore; the resolver/TTLs ride along in the closure (not container keys).
      const options = this.#refresh
      kit.container.bind(RefreshTokenService).toFunction(
        (jwt: JWTService, store: RefreshTokenStore) => new RefreshTokenService(jwt, store, options),
        [JWTService, RefreshTokenStore],
      )
    }

    if (this.#oidcHandlers.length > 0) {
      this.#assertOIDCIsolation(defaultScheme)

      const meta: OIDCMeta = {
        handlers: this.#oidcHandlers.map(h => ({ callbackPath: h.callbackPath, handler: h })),
      }
      kit.container.bind(kOIDCMeta).toValue(meta).internal()
    }

    kit.feats.toggleAuthentication(true)

    return Promise.resolve()
  }

  /**
   * Rejects configurations where two OIDC strategies would collide or one would be unreachable.
   *
   * Every check here is for a failure that is silent at runtime: colliding cookies look like
   * random logouts, a duplicate callback path resolves to whichever route registered first,
   * and a second strategy that is never the default simply never authenticates anyone. All of
   * them are cheap to detect at startup and expensive to diagnose in production.
   *
   * Note that two strategies sharing an *issuer* is allowed: one identity provider with two
   * client registrations is a normal setup, and it is safe once cookies, callback paths and
   * derived keys are distinct.
   */
  #assertOIDCIsolation(defaultScheme: string): void {
    const seen = new Map<string, Map<string, string>>([
      ['callbackPath', new Map()],
      ['session cookie name', new Map()],
      ['state cookie name', new Map()],
    ])

    // Two handlers sharing a scheme name derive their sealed-cookie keys from the same HKDF
    // namespace, so a session sealed by one could be opened by the other even across protocols
    // (an OAuth2 identity, from an unverified JSON body, accepted as OIDC). The cookie-name
    // checks below do not catch it because the protocol prefix makes the names differ; unique
    // names are the invariant that actually keeps the key namespaces apart, so enforce it here.
    const names = new Set<string>()

    for (const handler of this.#oidcHandlers) {
      if (names.has(handler.schemeName)) {
        throw new Error(
          `Cannot configure authentication: two OAuth strategies share the name "${handler.schemeName}"`,
        )
      }
      names.add(handler.schemeName)

      const values: Array<[string, string]> = [
        ['callbackPath', handler.callbackPath],
        ['session cookie name', handler.sessionCookieName],
        ['state cookie name', handler.stateCookieName],
      ]

      for (const [label, value] of values) {
        const owners = seen.get(label)!
        const owner = owners.get(value)
        if (owner !== undefined) {
          throw new Error(
            `Cannot configure authentication: OIDC strategies "${owner}" and "${handler.schemeName}" `
            + `share the ${label} "${value}"`,
          )
        }
        owners.set(value, handler.schemeName)
      }
    }

    if (this.#oidcHandlers.length < 2) {
      return
    }

    // The request pipeline authenticates the default scheme only, so with several OIDC
    // strategies every one but the default would be dead weight. Forward is what lets the
    // application pick per request.
    const registered = this.#schemes.get(defaultScheme)

    // A default that names nothing must not pass silently: an undefined lookup used to make the
    // guard below a no-op, so a typo'd default sailed through startup and failed only at request
    // time when the scheme could not be resolved. The Forward default must be registered as a
    // handler instance (which `forward()` does) rather than a bare container Key, so that the
    // check below can see it without eagerly instantiating every container-bound handler.
    if (registered === undefined) {
      throw new Error(
        `Cannot configure authentication: the default authenticate scheme "${defaultScheme}" is not a registered strategy`,
      )
    }

    if (!(registered instanceof ForwardAuthenticationHandler)) {
      throw new Error(
        'Cannot configure authentication: multiple OAuth strategies require a Forward default '
        + `authenticate scheme, but "${defaultScheme}" is not one`,
      )
    }
  }
}

function isConstructable<T>(value: unknown): value is Ctor<T> {
  return typeof value === 'function' && value.prototype !== undefined && value.prototype.constructor === value
}

function isKey<T>(value: Key<T> | T): value is Key<T> {
  return typeof value === 'string' || typeof value === 'symbol' || isConstructable(value)
}
