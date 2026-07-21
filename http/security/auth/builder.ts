import { Provider, type Ctor, type Key } from '@caffeinejs/core'
import { Context } from '../../context.js'
import type { PrincipalMapper } from '../index.js'
import { kConfigure, Service, ServiceKit } from '../../service.js'
import type { AuthenticationHandler } from './handler.js'
import { AuthenticationSchemeProvider } from './scheme_provider.js'
import { AuthenticationService } from './service.js'
import { BasicAuthenticationHandler } from './strategy/basic.js'
import { BasicAuthenticationOptionsBuilder } from './strategy/basic_options.js'
import { ForwardAuthenticationHandler } from './strategy/forward.js'
import { JWTAuthenticationHandler } from './strategy/jwt.js'
import { kAuthOpts } from './keys.js'
import { JWTAuthenticationOptionsBuilder } from './strategy/jwt_options.js'
import { GOOGLE_ISSUER, OidcAuthenticationHandler, OidcAuthenticationOptionsBuilder, kOidcMeta } from './strategy/oidc/index.js'
import type { OidcMeta } from './strategy/oidc/index.js'

export interface AuthenticationOptions {
  defaultAuthenticateScheme: string
  defaultChallengeScheme?: string
  defaultForbidScheme?: string
}

export class AuthenticationBuilder implements Service {
  readonly #schemes: Map<string, Key<AuthenticationHandler> | AuthenticationHandler> = new Map()
  readonly #options: Partial<AuthenticationOptions>
  readonly #oidcHandlers: OidcAuthenticationHandler[] = []

  #mapper: PrincipalMapper | string | symbol | undefined

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

  addBasicAuth(opts: (opts: BasicAuthenticationOptionsBuilder) => void): this
  addBasicAuth(name: string, opts: (opts: BasicAuthenticationOptionsBuilder) => void): this
  addBasicAuth(
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

  addOidc(name: string, configure: (opts: OidcAuthenticationOptionsBuilder) => void): this {
    const builder = new OidcAuthenticationOptionsBuilder()
    configure(builder)
    const handler = new OidcAuthenticationHandler(name, builder.build())
    this.#oidcHandlers.push(handler)
    return this.addStrategy(name, handler)
  }

  addOidcGoogle(name: string, configure: (opts: OidcAuthenticationOptionsBuilder) => void): this {
    return this.addOidc(name, opts => {
      opts.discoveryUrl(GOOGLE_ISSUER).issuer(GOOGLE_ISSUER)
      configure(opts)
    })
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

  [kConfigure](kit: ServiceKit): Promise<void> {
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

    for (const [, handler] of schemes) {
      if (handler instanceof ForwardAuthenticationHandler) {
        handler.setSchemeProvider(schemeProvider)
      }
    }

    kit.container.bind(AuthenticationService).toValue(service).internal()
    kit.container.bind(kAuthOpts).toValue(options).internal()

    if (this.#oidcHandlers.length > 0) {
      const meta: OidcMeta = {
        handlers: this.#oidcHandlers.map(h => ({ callbackPath: h.callbackPath, handler: h })),
      }
      kit.container.bind(kOidcMeta).toValue(meta).internal()
    }

    kit.feats.toggleAuthentication(true)

    return Promise.resolve()
  }
}

function isConstructable<T>(value: unknown): value is Ctor<T> {
  return typeof value === 'function' && value.prototype !== undefined && value.prototype.constructor === value
}
