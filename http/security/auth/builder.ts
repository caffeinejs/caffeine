import { Provider, type Ctor, type InjectionToken } from '@caffeinejs/di'
import { FeatureBuilder, kFeatureName, type BeforeBootstrapKit, type BootstrapKit } from '@caffeinejs/std'
import { type ConfigSchema, type ConfigSlice } from '@caffeinejs/std/config'

import { Context } from '../../context.js'
import { ServerOwnedPaths } from '../../server_owned_paths.js'
import type { PrincipalMapper } from '../index.js'
import { BasicAuthenticationHandler } from './basic/basic.js'
import { BasicAuthenticationOptionsBuilder } from './basic/basic_options.js'
import {
  CREDENTIALS_CONFIG_SEGMENT,
  REFRESH_CONFIG_SEGMENT,
  SCHEME_CONFIG,
  applyScheme,
  authConfigSchema,
  credentialsConfigSchema,
  refresh,
  refreshConfigSchema,
  authSubNamespace,
  schemeNamespace,
  type AuthConfigSlice,
  type SchemeConfigSpec,
  type SchemeKind,
} from './config.js'
import { CookieAuthenticationHandler } from './cookie/cookie.js'
import { CookieAuthenticationOptionsBuilder } from './cookie/cookie_options.js'
import { RememberMeTokenStore } from './cookie/remember_me_token_store.js'
import { CredentialsService, type CredentialsServiceOptions } from './credentials/credentials_service.js'
import { PasswordHasher, ScryptPasswordHasher } from './credentials/password_hasher.js'
import { UserProvider } from './credentials/user_provider.js'
import type { AuthSchemeDescriptor, AuthSchemeFlows } from './descriptor.js'
import { ErrAuthConfiguration } from './errors.js'
import { ForwardAuthenticationHandler } from './forward/forward.js'
import type { AuthenticationHandler } from './handler.js'
import { JWTAuthenticationHandler } from './jwt/jwt.js'
import { JWTAuthenticationOptionsBuilder } from './jwt/jwt_options.js'
import { JWTService } from './jwt/jwt_service.js'
import { jwtServiceKey } from './jwt/keys.js'
import { kAuthSchemeDescriptors } from './keys.js'
import { githubOAuth2Preset, OAuth2AuthenticationHandler, OAuth2AuthenticationOptionsBuilder } from './oauth/index.js'
import type { GithubPresetOptions } from './oauth/provider/github.js'
import { GOOGLE_ISSUER, OIDCAuthenticationHandler, OIDCAuthenticationOptionsBuilder } from './oidc/index.js'
import type { OAuthCallbackHandler, OIDCMeta } from './oidc/index.js'
import { OIDCRoutesExtension } from './oidc/oidc_routes.js'
import { OpaqueTokenAuthenticationHandler } from './opaque/opaque.js'
import { OpaqueTokenAuthenticationOptionsBuilder } from './opaque/opaque_options.js'
import { OpaqueTokenStore } from './opaque/opaque_token_store.js'
import { type RefreshTokenOptions, RefreshTokenOptionsBuilder } from './refresh/refresh_options.js'
import { RefreshTokenService } from './refresh/refresh_token_service.js'
import { RefreshTokenStore } from './refresh/refresh_token_store.js'
import { AuthenticationSchemeProvider } from './scheme_provider.js'
import { AuthenticationService } from './service.js'

/** The OIDC/OAuth callback paths, so a SPA fallback does not treat them as unmatched client routes. */
class OIDCOwnedPaths extends ServerOwnedPaths {
  constructor(readonly paths: readonly string[]) {
    super()
  }
}

export interface AuthenticationOptions {
  defaultAuthenticateScheme: string
  defaultChallengeScheme?: string
  defaultForbidScheme?: string
}

/**
 * A scheme the application asked for, before anything was built.
 *
 * Nothing is constructed inside the `addX(...)` callback any more: the callback is held here and run while the
 * feature configures, which is after configuration has resolved. That is what lets a JWT secret or an OIDC
 * client secret come from the environment — the handler is built from the merged options, once.
 */
interface SchemeRegistration {
  name: string
  kind: SchemeKind
  configure: (builder: never) => void
  /** github's endpoint and scope defaults, applied to the raw options before they are resolved. */
  preset?: GithubPresetOptions
}

export class AuthenticationBuilder<C = unknown> extends FeatureBuilder<AuthConfigSlice, C> {
  readonly [kFeatureName] = 'auth'

  protected readonly schema = authConfigSchema

  readonly #schemes: Map<string, InjectionToken<AuthenticationHandler> | AuthenticationHandler> = new Map()
  readonly #options: Partial<AuthenticationOptions>
  readonly #oidcHandlers: OAuthCallbackHandler[] = []
  // How each scheme expects credentials, recorded here because this is the one place that knows: `addStrategy`
  // receives a handler it cannot interrogate, and by configure time everything is a Provider wrapper.
  readonly #descriptors: Map<string, AuthSchemeDescriptor> = new Map()
  // Declared but not yet built, in call order — the order the schemes are registered in still decides which is
  // the implicit default when only one exists.
  readonly #registrations: SchemeRegistration[] = []
  readonly #slices: Map<string, ConfigSlice<Record<string, unknown>>> = new Map()

  #mapper: PrincipalMapper | InjectionToken<PrincipalMapper> | undefined
  #credentials: CredentialsServiceOptions | undefined
  #refreshConfigure: ((options: RefreshTokenOptionsBuilder) => void) | undefined
  #refresh: RefreshTokenOptions | undefined
  #credentialsSlice: ConfigSlice<CredentialsServiceOptions> | undefined
  #refreshSlice: ConfigSlice<Record<string, unknown>> | undefined

  constructor(options: Partial<AuthenticationOptions> = {}) {
    super()
    this.#options = options
  }

  addStrategy(name: string, handler: AuthenticationHandler): this
  addStrategy(name: string, key: InjectionToken<AuthenticationHandler>): this
  addStrategy(name: string, keyOrHandler: InjectionToken<AuthenticationHandler> | AuthenticationHandler): this {
    this.#schemes.set(name, keyOrHandler)
    return this
  }

  /**
   * Records a scheme to be built once configuration has resolved.
   *
   * The scheme's slot is reserved now even though the handler does not exist yet: registration order decides
   * which scheme is the implicit default when only one exists, and a `Map` keeps a key's original position
   * when its value is replaced later.
   */
  #register(name: string, kind: SchemeKind, configure: (builder: never) => void, preset?: GithubPresetOptions): this {
    this.#registrations.push({ name, kind, configure, preset })
    this.#schemes.set(name, undefined as unknown as AuthenticationHandler)
    return this
  }

  /**
   * Records how `name` expects credentials. Called by the `addX` methods, which are the only ones that know;
   * a scheme registered through a bare `addStrategy` stays undescribed.
   */
  #describe(name: string, descriptor: AuthSchemeDescriptor): void {
    this.#descriptors.set(name, descriptor)
  }

  addJWTBearer(opts: (opts: JWTAuthenticationOptionsBuilder) => void): this
  addJWTBearer(name: string, opts: (opts: JWTAuthenticationOptionsBuilder) => void): this
  addJWTBearer(
    optsOrName: ((opts: JWTAuthenticationOptionsBuilder) => void) | string,
    options?: (opts: JWTAuthenticationOptionsBuilder) => void,
  ): this {
    const name = typeof optsOrName === 'string' ? optsOrName : 'Bearer'
    const optsFn = typeof optsOrName === 'string' ? options : optsOrName
    if (!optsFn) {
      throw new ErrAuthConfiguration('Options are required')
    }

    return this.#register(name, 'jwt', optsFn as (builder: never) => void)
  }

  addBasic(opts: (opts: BasicAuthenticationOptionsBuilder) => void): this
  addBasic(name: string, opts: (opts: BasicAuthenticationOptionsBuilder) => void): this
  addBasic(
    optsOrName: ((opts: BasicAuthenticationOptionsBuilder) => void) | string,
    options?: (opts: BasicAuthenticationOptionsBuilder) => void,
  ): this {
    const name = typeof optsOrName === 'string' ? optsOrName : 'Basic'
    const optsFn = typeof optsOrName === 'string' ? options : optsOrName
    if (!optsFn) {
      throw new ErrAuthConfiguration('Options are required')
    }

    return this.#register(name, 'basic', optsFn as (builder: never) => void)
  }

  addCookie(opts: (opts: CookieAuthenticationOptionsBuilder) => void): this
  addCookie(name: string, opts: (opts: CookieAuthenticationOptionsBuilder) => void): this
  addCookie(
    optsOrName: ((opts: CookieAuthenticationOptionsBuilder) => void) | string,
    options?: (opts: CookieAuthenticationOptionsBuilder) => void,
  ): this {
    const name = typeof optsOrName === 'string' ? optsOrName : 'Cookie'
    const optsFn = typeof optsOrName === 'string' ? options : optsOrName
    if (!optsFn) {
      throw new ErrAuthConfiguration('Options are required')
    }

    return this.#register(name, 'cookie', optsFn as (builder: never) => void)
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
    const name = typeof optsOrName === 'string' ? optsOrName : 'OpaqueToken'
    const optsFn = typeof optsOrName === 'string' ? options : optsOrName

    // The options callback is optional: `store` defaults to the `OpaqueTokenStore` token, so the
    // zero-arg form works once the user has bound their store to the container.
    return this.#register(name, 'opaque', (optsFn ?? noOptions) as (builder: never) => void)
  }

  addOIDC(name: string, configure: (opts: OIDCAuthenticationOptionsBuilder) => void): this {
    return this.#register(name, 'oidc', configure as (builder: never) => void)
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
    return this.#register(name, 'oauth', configure as (builder: never) => void)
  }

  addGithub(
    name: string,
    configure: (opts: OAuth2AuthenticationOptionsBuilder) => void,
    preset: GithubPresetOptions = {},
  ): this {
    return this.#register(name, 'github', configure as (builder: never) => void, preset)
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

  mapUser(mapper: PrincipalMapper | InjectionToken<PrincipalMapper>): this {
    this.#mapper = mapper
    return this
  }

  /**
   * Enables the bearer refresh-token grant. Binds a {@link RefreshTokenService} (issue / refresh /
   * revoke) that signs access tokens with the default JWT scheme's shared service and persists refresh
   * tokens in the container-bound {@link RefreshTokenStore}. Requires a JWT bearer scheme.
   */
  addRefreshTokens(configure: (options: RefreshTokenOptionsBuilder) => void): this {
    this.#refreshConfigure = configure
    return this
  }

  protected override configValues(): Record<string, unknown> {
    return {
      defaultAuthenticateScheme: this.#options.defaultAuthenticateScheme,
      defaultChallengeScheme: this.#options.defaultChallengeScheme,
      defaultForbidScheme: this.#options.defaultForbidScheme,
    }
  }

  protected bootstrap(kit: BootstrapKit): void {
    this.#doBootstrap(kit)
  }

  protected override beforeBootstrap(kit: BeforeBootstrapKit): void {
    // Read back rather than recomputed, so the schemes follow the block they belong to wherever `.config(...)`
    // put it — and stay detached along with it when the application placed it nowhere.
    const base = this.slice.parts

    for (const registration of this.#registrations) {
      this.#slices.set(
        registration.name,
        kit.config.slice(schemeNamespace(base, registration.name), SCHEME_CONFIG[registration.kind].schema),
      )
    }

    if (this.#credentials !== undefined) {
      this.#credentialsSlice = kit.config.slice(
        authSubNamespace(base, CREDENTIALS_CONFIG_SEGMENT),
        credentialsConfigSchema,
      )
    }

    if (this.#refreshConfigure !== undefined) {
      this.#refreshSlice = kit.config.slice(
        authSubNamespace(base, REFRESH_CONFIG_SEGMENT),
        refreshConfigSchema as ConfigSchema<Record<string, unknown>>,
      )
    }
  }

  /**
   * Builds each declared scheme from its merged options, then wires everything into the container.
   *
   * Per scheme, in this order: run the application's own callback (code values), replay whatever configuration
   * resolved over the top, then `build()`. Building last is what makes each scheme's own validation —
   * `assertSecureEndpoint`, the session-secret length check, "authorizationEndpoint is required" — see the
   * *merged* options rather than only the half that was written in code.
   */
  #buildSchemes(): void {
    for (const registration of this.#registrations) {
      const configured = this.#slices.get(registration.name)?.config ?? {}

      switch (registration.kind) {
        case 'jwt': {
          const builder = new JWTAuthenticationOptionsBuilder()
          registration.configure(builder as never)
          applyScheme(builder, SCHEME_CONFIG.jwt as SchemeConfigSpec<JWTAuthenticationOptionsBuilder>, configured)

          this.#describe(registration.name, { kind: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
          this.addStrategy(registration.name, new JWTAuthenticationHandler(registration.name, builder.build()))
          break
        }

        case 'basic': {
          const builder = new BasicAuthenticationOptionsBuilder()
          registration.configure(builder as never)
          applyScheme(builder, SCHEME_CONFIG.basic as SchemeConfigSpec<BasicAuthenticationOptionsBuilder>, configured)

          this.#describe(registration.name, { kind: 'http', scheme: 'basic' })
          this.addStrategy(registration.name, new BasicAuthenticationHandler(registration.name, builder.build()))
          break
        }

        case 'cookie': {
          const builder = new CookieAuthenticationOptionsBuilder()
          registration.configure(builder as never)
          applyScheme(builder, SCHEME_CONFIG.cookie as SchemeConfigSpec<CookieAuthenticationOptionsBuilder>, configured)
          const resolved = builder.build()

          this.#describe(registration.name, { kind: 'apiKey', in: 'cookie', name: resolved.cookieName })
          this.addStrategy(registration.name, new CookieAuthenticationHandler(registration.name, resolved))
          break
        }

        case 'opaque': {
          const builder = new OpaqueTokenAuthenticationOptionsBuilder()
          registration.configure(builder as never)
          applyScheme(
            builder,
            SCHEME_CONFIG.opaque as SchemeConfigSpec<OpaqueTokenAuthenticationOptionsBuilder>,
            configured,
          )
          const resolved = builder.build()

          this.#describe(registration.name, {
            kind: 'http',
            scheme: (resolved.scheme ?? 'Bearer').toLowerCase(),
            description: 'Opaque token, verified against a server-side store',
          })
          this.addStrategy(registration.name, new OpaqueTokenAuthenticationHandler(registration.name, resolved))
          break
        }

        case 'oidc': {
          const builder = new OIDCAuthenticationOptionsBuilder()
          registration.configure(builder as never)
          applyScheme(builder, SCHEME_CONFIG.oidc as SchemeConfigSpec<OIDCAuthenticationOptionsBuilder>, configured)

          const options = builder.build(registration.name)
          const handler = new OIDCAuthenticationHandler(registration.name, options)
          this.#oidcHandlers.push(handler)

          // Only a discovery URL describes the sign-in as OpenID Connect; a provider configured with explicit
          // endpoints is an OAuth 2.0 authorization-code flow as far as any consumer can tell.
          this.#describe(
            registration.name,
            sessionCookieScheme(
              handler,
              options.discoveryURL !== undefined
                ? { openIdConnectURL: options.discoveryURL }
                : {
                    flows: authorizationCodeFlow(options.authorizationEndpoint, options.tokenEndpoint, options.scopes),
                  },
            ),
          )

          this.addStrategy(registration.name, handler)
          break
        }

        case 'oauth':
        case 'github': {
          const builder = new OAuth2AuthenticationOptionsBuilder()
          registration.configure(builder as never)
          applyScheme(builder, SCHEME_CONFIG.oauth as SchemeConfigSpec<OAuth2AuthenticationOptionsBuilder>, configured)

          // Raw options, not `build(name)`: the handler constructor is the single resolution point, so
          // resolving here as well would validate and default the options twice. The github preset supplies
          // the endpoints, subjectClaim and scope defaults that resolution requires, so it has to be folded
          // in before resolution rather than after.
          const raw =
            registration.kind === 'github'
              ? githubOAuth2Preset({ ...builder.toOptions(), ...registration.preset })
              : builder.toOptions()

          const handler = new OAuth2AuthenticationHandler(registration.name, raw)
          this.#oidcHandlers.push(handler)

          // Read back off the handler: it resolved the raw options, so this is what the flow actually uses.
          this.#describe(
            registration.name,
            sessionCookieScheme(handler, {
              flows: authorizationCodeFlow(
                handler.options.authorizationEndpoint,
                handler.options.tokenEndpoint,
                handler.options.scopes,
              ),
            }),
          )

          this.addStrategy(registration.name, handler)
          break
        }
      }
    }

    if (this.#refreshConfigure !== undefined) {
      const builder = new RefreshTokenOptionsBuilder()
      this.#refreshConfigure(builder)
      applyScheme(builder, refresh, this.#refreshSlice?.config ?? {})
      this.#refresh = builder.build()
    }

    if (this.#credentials !== undefined && this.#credentialsSlice !== undefined) {
      this.#credentials = { ...this.#credentials, ...stripUndefined(this.#credentialsSlice.config) }
    }
  }

  #doBootstrap(kit: BootstrapKit): void {
    this.#buildSchemes()

    // Absent for a builder driven directly rather than by an application, which then has only what code set.
    const configuredDefaults = this.declared ? this.slice.config : {}
    const opts: Partial<AuthenticationOptions> = { ...this.#options, ...stripUndefined(configuredDefaults) }
    const firstScheme = this.#schemes.keys().next().value as string | undefined

    const schemeCount = this.#schemes.size
    const defaultScheme = opts.defaultAuthenticateScheme ?? (schemeCount === 1 ? firstScheme : undefined)
    if (!defaultScheme) {
      throw new ErrAuthConfiguration(
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

    const mapper =
      this.#mapper === undefined
        ? undefined
        : typeof this.#mapper === 'string' || typeof this.#mapper === 'symbol'
          ? kit.container.wrap(this.#mapper as InjectionToken<PrincipalMapper>)
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

    // The scheme provider carries the resolved options — the default authenticate, challenge and forbid
    // schemes, and the registered names — so binding it is the whole of publishing them.
    kit.container.bind(AuthenticationService, t => t.toValue(service).internal())
    kit.container.bind(AuthenticationSchemeProvider, t => t.toValue(schemeProvider).internal())
    kit.container.bind(kAuthSchemeDescriptors, t => t.toValue(this.#descriptors).internal())

    // Share each JWT scheme's service (verify + sign) for injection into token-issuing controllers.
    // Every JWT scheme is reachable via its keyed token; the default JWT scheme (or the first, if the
    // default is not a JWT scheme) is also bound under the bare `JWTService` token for the common case.
    const jwtSchemes = [...this.#schemes].filter(
      (entry): entry is [string, JWTAuthenticationHandler] => entry[1] instanceof JWTAuthenticationHandler,
    )
    for (const [name, handler] of jwtSchemes) {
      kit.container.bind(jwtServiceKey(name), t => t.toValue(handler.service))
    }
    if (jwtSchemes.length > 0) {
      const preferred = jwtSchemes.find(([name]) => name === defaultScheme) ?? jwtSchemes[0]
      kit.container.bind(JWTService, t => t.toValue(preferred[1].service))
    }

    if (this.#credentials !== undefined) {
      // Default hasher is a fallback so a user-bound PasswordHasher wins. CredentialsService is a
      // public binding (controllers inject it); it resolves the user-bound UserProvider and the
      // PasswordHasher, and the configured options ride along in the closure (a value that is not a
      // container key, so a plain DI injection cannot carry it).
      const options = this.#credentials
      kit.container.bind(PasswordHasher, t => t.toClass(ScryptPasswordHasher).fallback())
      kit.container.bind(CredentialsService, t =>
        t.toFunction(
          (provider: UserProvider, hasher: PasswordHasher) => new CredentialsService(provider, hasher, options),
          [UserProvider, PasswordHasher],
        ),
      )
    }

    if (this.#refresh !== undefined) {
      if (jwtSchemes.length === 0) {
        throw new ErrAuthConfiguration(
          'Cannot configure refresh tokens: no JWT scheme is registered (add a JWT bearer scheme via addJWTBearer)',
        )
      }

      // Signs with the shared (default) JWTService bound above and persists in the user-bound
      // RefreshTokenStore; the resolver/TTLs ride along in the closure (not container keys).
      const options = this.#refresh
      kit.container.bind(RefreshTokenService, t =>
        t.toFunction(
          (jwt: JWTService, store: RefreshTokenStore) => new RefreshTokenService(jwt, store, options),
          [JWTService, RefreshTokenStore],
        ),
      )
    }

    if (this.#oidcHandlers.length > 0) {
      this.#assertOIDCIsolation(defaultScheme)

      const meta: OIDCMeta = {
        handlers: this.#oidcHandlers.map(h => ({ callbackPath: h.callbackPath, handler: h })),
        unreachableCandidates: this.#unreachableCandidates(defaultScheme),
      }

      // Registered only here, so "no OIDC strategy was configured" is expressed as the extension not
      // existing rather than as a flag it would have to read back and check.
      kit.extensions.register(OIDCRoutesExtension, new OIDCRoutesExtension(meta))
      kit.container.bind(OIDCOwnedPaths, t =>
        t
          .toValue(new OIDCOwnedPaths(meta.handlers.map(h => h.callbackPath)))
          .extends(ServerOwnedPaths)
          .internal(),
      )
    }
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
        throw new ErrAuthConfiguration(
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
          throw new ErrAuthConfiguration(
            `Cannot configure authentication: OIDC strategies "${owner}" and "${handler.schemeName}" ` +
              `share the ${label} "${value}"`,
          )
        }
        owners.set(value, handler.schemeName)
      }
    }

    // A default that names nothing must not pass silently: an undefined lookup used to make the guard
    // below a no-op, so a typo'd default sailed through startup and failed only at request time when the
    // scheme could not be resolved.
    if (!this.#schemes.has(defaultScheme)) {
      throw new ErrAuthConfiguration(
        `Cannot configure authentication: the default authenticate scheme "${defaultScheme}" is not a registered strategy`,
      )
    }

    // Registering several OAuth strategies without a Forward default used to be rejected outright, on the
    // grounds that the pipeline authenticates the default scheme only and every other strategy would be
    // dead weight. That stopped being true once a route could name its own schemes: `/login/google` and
    // `/login/github`, each naming one, is a perfectly good configuration.
    //
    // The underlying hazard is still real, so it is still reported — just as what it actually is, a
    // strategy nothing can reach, rather than as a demand for a particular default. Forward remains the
    // way to choose per request when routes do not name schemes themselves.
  }

  /**
   * OAuth strategies that no request can reach unless a route names them.
   *
   * A Forward default can select any scheme per request, so it makes all of them reachable. Otherwise the
   * pipeline authenticates the default only, and everything else depends on a route naming it — which the
   * builder cannot see. See {@link OIDCMeta.unreachableCandidates}.
   */
  #unreachableCandidates(defaultScheme: string): string[] {
    if (this.#schemes.get(defaultScheme) instanceof ForwardAuthenticationHandler) {
      return []
    }

    return this.#oidcHandlers.map(handler => handler.schemeName).filter(name => name !== defaultScheme)
  }
}

/** Stands in for an omitted options callback: the scheme runs on its own defaults plus whatever is configured. */
function noOptions(): void {
  // Nothing to set.
}

/**
 * Drops the keys a slice published as `undefined`, so spreading it over the code values overrides only what
 * configuration actually carried. A present-but-undefined key would erase the code value instead.
 */
function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}

function isConstructable<T>(value: unknown): value is Ctor<T> {
  return typeof value === 'function' && value.prototype !== undefined && value.prototype.constructor === value
}

function isKey<T>(value: InjectionToken<T> | T): value is InjectionToken<T> {
  return typeof value === 'string' || typeof value === 'symbol' || isConstructable(value)
}

/**
 * Builds the authorization-code flow of an {@link AuthSchemeDescriptor}, or nothing when the endpoints are not
 * both known — a half-described flow is worse than an absent one, because a consumer would render a broken
 * "Authorize" button rather than omit it.
 */
function authorizationCodeFlow(
  authorizationEndpoint: string | undefined,
  tokenEndpoint: string | undefined,
  scopes: readonly string[] | undefined,
): AuthSchemeFlows | undefined {
  if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
    return undefined
  }

  return {
    authorizationCode: {
      authorizationURL: authorizationEndpoint,
      tokenURL: tokenEndpoint,
      scopes: scopes ?? [],
    },
  }
}

/**
 * Describes an OAuth-family strategy by the transport it actually accepts.
 *
 * Every strategy in this family ends its sign-in by sealing a session into a cookie, and `authenticate()`
 * reads that cookie and nothing else — never an `Authorization` header. So the transport is an API key in a
 * cookie. Describing it as `oauth2` instead promises consumers a bearer token the handler would reject, and
 * a documentation UI acting on that promise runs the browser-side token exchange, which providers refuse
 * cross-origin anyway: the visible failure is a CORS error, and the invisible one is that the token it was
 * trying to obtain would not have authenticated anything.
 *
 * The sign-in is not lost. It rides along in `flows` or `openIdConnectURL`, which say how the credential is
 * obtained rather than how it travels.
 */
function sessionCookieScheme(
  handler: { readonly sessionCookieName: string },
  obtainedBy: Pick<AuthSchemeDescriptor, 'flows' | 'openIdConnectURL'>,
): AuthSchemeDescriptor {
  return { kind: 'apiKey', in: 'cookie', name: handler.sessionCookieName, ...obtainedBy }
}
