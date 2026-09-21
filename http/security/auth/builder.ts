import { DeferredCtor, Provider, type Ctor, type InjectionToken, type NamedToken } from '@caffeinejs/di'
import { kFeatureName, type FeatureConfigureKit } from '@caffeinejs/std'
import type { FastifyInstance } from 'fastify'

import { Context } from '../../context.js'
import { HTTPFeatureBuilder } from '../../feature.js'
import { ServerOwnedPaths } from '../../server_owned_paths.js'
import { authenticationPlugin } from '../authentication_plugin.js'
import type { PrincipalMapper } from '../index.js'
import { BasicAuthenticationHandler } from './basic/basic.js'
import { BasicAuthenticationOptionsBuilder } from './basic/basic_options.js'
import {
  SCHEME_CONFIG,
  applyScheme,
  credentialsConfigSchema,
  refresh,
  validated,
  type AuthConfig,
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
import { ErrAuthConfiguration, ErrAuthSchemeNotFound } from './errors.js'
import { ForwardAuthenticationHandler } from './forward/forward.js'
import type { AuthenticationHandler } from './handler.js'
import { JWTAuthenticationHandler } from './jwt/jwt.js'
import { JWTAuthenticationOptionsBuilder } from './jwt/jwt_options.js'
import { JWTService } from './jwt/jwt_service.js'
import { jwtServiceKey } from './jwt/keys.js'
import { kAuthSchemeDescriptors } from './keys.js'
import {
  githubOAuth2Preset,
  OAuth2AuthenticationHandler,
  type OAuth2AuthenticationOptions,
  OAuth2AuthenticationOptionsBuilder,
} from './oauth/index.js'
import type { GithubPresetOptions } from './oauth/provider/github.js'
import { GOOGLE_ISSUER, OIDCAuthenticationHandler, OIDCAuthenticationOptionsBuilder } from './oidc/index.js'
import type { OAuthCallbackHandler, OIDCMeta } from './oidc/index.js'
import { oidcRoutesPlugin } from './oidc/oidc_routes.js'
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
 * Nothing is constructed inside the `addX(...)` callback: the callback is held here and run while the feature
 * configures, which is after configuration has resolved. That is what lets a JWT secret or an OIDC client secret
 * come from the environment — the handler is built from the merged options, once.
 */
interface SchemeRegistration {
  name: string
  kind: SchemeKind
  /** @param configured - What the configuration tree carries for this scheme. */
  build(configured: Record<string, unknown>): BuiltScheme
}

interface BuiltScheme {
  handler: AuthenticationHandler
  /** How the scheme expects its credential, for whoever documents the routes it protects. */
  descriptor: AuthSchemeDescriptor
  /** Set by the OAuth-family kinds: they answer on a callback route, which the server has to register. */
  callback?: OAuthCallbackHandler
}

/** What building one kind of scheme takes: the options builder it starts from, the configuration it accepts, and
 * the handler its options make. */
interface SchemeKindSpec<B> {
  options(): B
  config: SchemeConfigSpec<B>
  build(name: string, options: B): BuiltScheme
}

const JWT_KIND: SchemeKindSpec<JWTAuthenticationOptionsBuilder> = {
  options: () => new JWTAuthenticationOptionsBuilder(),
  config: SCHEME_CONFIG.jwt,
  build: (name, options) => ({
    handler: new JWTAuthenticationHandler(name, options.build()),
    descriptor: { kind: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
  }),
}

const BASIC_KIND: SchemeKindSpec<BasicAuthenticationOptionsBuilder> = {
  options: () => new BasicAuthenticationOptionsBuilder(),
  config: SCHEME_CONFIG.basic,
  build: (name, options) => ({
    handler: new BasicAuthenticationHandler(name, options.build()),
    descriptor: { kind: 'http', scheme: 'basic' },
  }),
}

const COOKIE_KIND: SchemeKindSpec<CookieAuthenticationOptionsBuilder> = {
  options: () => new CookieAuthenticationOptionsBuilder(),
  config: SCHEME_CONFIG.cookie,
  build: (name, options) => {
    const resolved = options.build()

    return {
      handler: new CookieAuthenticationHandler(name, resolved),
      descriptor: { kind: 'apiKey', in: 'cookie', name: resolved.cookieName },
    }
  },
}

const OPAQUE_KIND: SchemeKindSpec<OpaqueTokenAuthenticationOptionsBuilder> = {
  options: () => new OpaqueTokenAuthenticationOptionsBuilder(),
  config: SCHEME_CONFIG.opaque,
  build: (name, options) => {
    const resolved = options.build()

    return {
      handler: new OpaqueTokenAuthenticationHandler(name, resolved),
      descriptor: {
        kind: 'http',
        scheme: (resolved.scheme ?? 'Bearer').toLowerCase(),
        description: 'Opaque token, verified against a server-side store',
      },
    }
  },
}

const OIDC_KIND: SchemeKindSpec<OIDCAuthenticationOptionsBuilder> = {
  options: () => new OIDCAuthenticationOptionsBuilder(),
  config: SCHEME_CONFIG.oidc,
  build: (name, options) => {
    const resolved = options.build(name)
    const handler = new OIDCAuthenticationHandler(name, resolved)

    // Only a discovery URL describes the sign-in as OpenID Connect; a provider configured with explicit
    // endpoints is an OAuth 2.0 authorization-code flow as far as any consumer can tell.
    const obtainedBy =
      resolved.discoveryURL !== undefined
        ? { openIdConnectURL: resolved.discoveryURL }
        : { flows: authorizationCodeFlow(resolved.authorizationEndpoint, resolved.tokenEndpoint, resolved.scopes) }

    return { handler, callback: handler, descriptor: sessionCookieScheme(handler, obtainedBy) }
  },
}

/**
 * Plain OAuth 2.0, and the presets over it.
 *
 * @param preset - Folded into the raw options before they are resolved: a preset supplies the endpoints, the
 * subject claim and the scope defaults that resolution requires.
 */
function oauthKind(
  preset: (options: OAuth2AuthenticationOptions) => OAuth2AuthenticationOptions = options => options,
): SchemeKindSpec<OAuth2AuthenticationOptionsBuilder> {
  return {
    options: () => new OAuth2AuthenticationOptionsBuilder(),
    config: SCHEME_CONFIG.oauth,
    build: (name, options) => {
      // Raw options, not `build(name)`: the handler constructor is the single resolution point, so resolving here
      // as well would validate and default the options twice.
      const handler = new OAuth2AuthenticationHandler(name, preset(options.toOptions()))

      // Read back off the handler: it resolved the raw options, so this is what the flow actually uses.
      const { authorizationEndpoint, tokenEndpoint, scopes } = handler.options

      return {
        handler,
        callback: handler,
        descriptor: sessionCookieScheme(handler, {
          flows: authorizationCodeFlow(authorizationEndpoint, tokenEndpoint, scopes),
        }),
      }
    },
  }
}

export class AuthenticationBuilder<C = unknown> extends HTTPFeatureBuilder<C> {
  readonly [kFeatureName] = 'auth'

  readonly #schemes: Map<string, InjectionToken<AuthenticationHandler> | AuthenticationHandler> = new Map()
  readonly #options: Partial<AuthenticationOptions>
  readonly #oidcHandlers: OAuthCallbackHandler[] = []
  // How each scheme expects credentials, recorded here because this is the one place that knows: `addStrategy`
  // receives a handler it cannot interrogate, and by configure time everything is a Provider wrapper.
  readonly #descriptors: Map<string, AuthSchemeDescriptor> = new Map()
  // Declared but not yet built, in call order — the order the schemes are registered in still decides which is
  // the implicit default when only one exists.
  readonly #registrations: SchemeRegistration[] = []

  #config: Partial<AuthConfig> | undefined
  #mapper: PrincipalMapper | NamedToken<PrincipalMapper> | undefined
  #credentials: CredentialsServiceOptions | undefined
  #refreshConfigure: ((options: RefreshTokenOptionsBuilder) => void) | undefined
  #refresh: RefreshTokenOptions | undefined
  #oidcMeta: OIDCMeta | undefined

  constructor(options: Partial<AuthenticationOptions> = {}) {
    super()
    this.#options = options
  }

  /**
   * Reads the default schemes, each scheme's own options, the credentials block and the refresh block from a
   * node of the configuration tree, e.g. `config.app.auth`.
   *
   * Configuration is applied **over** what the scheme's `addX(...)` callback set, so a secret written in code
   * is a default the environment can redirect. Each scheme is matched by the name it was registered under —
   * see {@link AuthConfig} for how that name has to be spelled for an environment variable to reach it.
   *
   * ```ts
   * .authentication((a, { config }) => a.config(config.app.auth).addJWTBearer('jwt', j => j.issuer('local')))
   * ```
   */
  config(config: Partial<AuthConfig>): this {
    this.#config = config
    return this
  }

  /**
   * Registers a handler of the application's own, or the container key one resolves from.
   *
   * @throws ErrAuthConfiguration when a scheme is already registered under `name`.
   */
  addStrategy(name: string, handler: AuthenticationHandler): this
  addStrategy(name: string, key: InjectionToken<AuthenticationHandler>): this
  addStrategy(name: string, keyOrHandler: InjectionToken<AuthenticationHandler> | AuthenticationHandler): this {
    this.#reserve(name)
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
  #register<B>(name: string, kind: SchemeKind, spec: SchemeKindSpec<B>, configure: (options: B) => void): this {
    this.#reserve(name)
    this.#registrations.push({
      name,
      kind,
      // Code first, configuration over it, and only then the build: building last is what puts each scheme's own
      // validation on the merged options, not on the half that was written in code.
      build: configured => {
        const options = spec.options()

        configure(options)
        applyScheme(options, spec.config, configured, `authentication scheme "${name}"`)

        return spec.build(name, options)
      },
    })
    this.#schemes.set(name, undefined as unknown as AuthenticationHandler)
    return this
  }

  /**
   * A second scheme under a name would replace the first without a word, whichever kind either of them is.
   *
   * Unique names are also what keeps the OAuth strategies' sealed cookies apart: each derives its keys from its
   * name, so two sharing one could open each other's sessions, even across protocols.
   */
  #reserve(name: string): void {
    if (this.#schemes.has(name)) {
      throw new ErrAuthConfiguration(
        `Cannot configure authentication: a scheme is already registered under the name "${name}"`,
      )
    }
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

    return this.#register(name, 'jwt', JWT_KIND, optsFn)
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

    return this.#register(name, 'basic', BASIC_KIND, optsFn)
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

    return this.#register(name, 'cookie', COOKIE_KIND, optsFn)
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
    return this.#register(name, 'opaque', OPAQUE_KIND, optsFn ?? noOptions)
  }

  addOIDC(name: string, configure: (opts: OIDCAuthenticationOptionsBuilder) => void): this {
    return this.#register(name, 'oidc', OIDC_KIND, configure)
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
    return this.#register(name, 'oauth', oauthKind(), configure)
  }

  addGithub(
    name: string,
    configure: (opts: OAuth2AuthenticationOptionsBuilder) => void,
    preset: GithubPresetOptions = {},
  ): this {
    return this.#register(
      name,
      'github',
      oauthKind(options => githubOAuth2Preset({ ...options, ...preset })),
      configure,
    )
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

  /**
   * Maps every authenticated principal before the request sees it.
   *
   * @param mapper - The function itself, or the named token one is bound under. A class cannot be the key: a
   * mapper is a function, and a function handed over here is taken to be the mapper.
   */
  mapUser(mapper: PrincipalMapper | NamedToken<PrincipalMapper>): this {
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

  protected override configure(kit: FeatureConfigureKit<C>): void {
    this.#doConfigure(kit)
  }

  protected override async server(instance: FastifyInstance): Promise<void> {
    // The gate lands where `.authentication(...)` was written: everything installed before it runs ahead of
    // the hook, everything after it only for a request the hook let through.
    await instance.register(authenticationPlugin())

    if (this.#oidcMeta !== undefined) {
      await instance.register(oidcRoutesPlugin(this.#oidcMeta))
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
      const built = registration.build(this.#config?.schemes?.[registration.name] ?? {})

      this.#describe(registration.name, built.descriptor)
      this.#schemes.set(registration.name, built.handler)

      if (built.callback !== undefined) {
        this.#oidcHandlers.push(built.callback)
      }
    }

    if (this.#refreshConfigure !== undefined) {
      const builder = new RefreshTokenOptionsBuilder()
      this.#refreshConfigure(builder)
      applyScheme(builder, refresh, this.#config?.refresh ?? {}, 'refresh tokens')
      this.#refresh = builder.build()
    }

    if (this.#credentials !== undefined && this.#config?.credentials !== undefined) {
      const configured = validated({ schema: credentialsConfigSchema }, this.#config.credentials, 'credentials')
      this.#credentials = { ...this.#credentials, ...stripUndefined(configured) }
    }
  }

  #doConfigure(kit: FeatureConfigureKit<C>): void {
    this.#buildSchemes()

    // Configuration over code, the same order the schemes themselves are merged in.
    const opts: Partial<AuthenticationOptions> = {
      ...this.#options,
      ...stripUndefined({
        defaultAuthenticateScheme: this.#config?.defaultAuthenticateScheme,
        defaultChallengeScheme: this.#config?.defaultChallengeScheme,
        defaultForbidScheme: this.#config?.defaultForbidScheme,
      }),
    }
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

    // The three defaults are used for every request that names no scheme of its own, so one that resolves to
    // nothing fails all of them. Known now, refused now.
    for (const name of [defaultScheme, options.defaultChallengeScheme, options.defaultForbidScheme]) {
      if (name !== undefined && !this.#schemes.has(name)) {
        throw new ErrAuthSchemeNotFound(name, [...this.#schemes.keys()])
      }
    }

    const schemes = new Map<string, Provider<AuthenticationHandler>>()
    for (const [name, keyOrHandler] of this.#schemes) {
      // A key of any spelling — a class, a named token — resolves from the container. Only what is left is the
      // handler itself.
      const handler: Provider<AuthenticationHandler> = isKey(keyOrHandler)
        ? kit.container.wrap(keyOrHandler)
        : { get: () => keyOrHandler }
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
        keyOrHandler.setService(service)
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
      this.#assertOIDCIsolation()

      const meta: OIDCMeta = {
        handlers: this.#oidcHandlers.map(h => ({ callbackPath: h.callbackPath, handler: h })),
        unreachableCandidates: this.#unreachableCandidates(defaultScheme),
      }

      // Registered only here, so "no OIDC strategy was configured" is expressed as the extension not
      // existing rather than as a flag it would have to read back and check.
      this.#oidcMeta = meta
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
  #assertOIDCIsolation(): void {
    // A callback path and a sign-in path are both routes, so they are kept apart from each other as well.
    const paths = new Map<string, string>()
    const seen = new Map<string, Map<string, string>>([
      ['callbackPath', paths],
      ['loginPath', paths],
      ['session cookie name', new Map()],
      ['state cookie name', new Map()],
    ])

    for (const handler of this.#oidcHandlers) {
      const values: Array<[string, string]> = [
        ['callbackPath', handler.callbackPath],
        ['loginPath', handler.loginPath],
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
  return (
    typeof value === 'string' || typeof value === 'symbol' || isConstructable(value) || value instanceof DeferredCtor
  )
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
