import { Provider, type Container, type Ctor, type Key } from '@caffeinejs/core'
import { Context } from '../../context.js'
import type { PrincipalMapper } from '../principal.js'
import type { AuthenticationHandler } from './handler.js'
import { AuthenticationSchemeProvider } from './scheme_provider.js'
import { AuthenticationCoordinator } from './service.js'
import { JWTAuthenticationHandler } from './handler/jwt.js'
import { kAuthOpts } from './keys.js'
import { JWTAuthenticationOptionsBuilder } from './handler/jwt_options.js'
import { ForwardAuthenticationHandler } from './handler/forward.js'

export interface AuthenticationOptions {
  defaultAuthenticateScheme: string
}

export class AuthenticationBuilder {
  readonly #container: Container
  readonly #schemes: Map<string, Key<AuthenticationHandler> | AuthenticationHandler> = new Map()
  readonly #options: Partial<AuthenticationOptions>

  #mapper: PrincipalMapper | string | symbol | undefined

  constructor(container: Container, options: Partial<AuthenticationOptions> = {}) {
    this.#container = container
    this.#options = options
  }

  addScheme(name: string, handler: AuthenticationHandler): this
  addScheme(name: string, key: Key<AuthenticationHandler>): this
  addScheme(name: string, keyOrHandler: Key<AuthenticationHandler> | AuthenticationHandler): this {
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

    return this.addScheme(name, new JWTAuthenticationHandler(name, builder.build()))
  }

  forward(name: string, selector: (ctx: Context) => string | Promise<string>): this {
    const handler = new ForwardAuthenticationHandler(selector)
    return this.addScheme(name, handler)
  }

  default(name: string): this {
    this.#options.defaultAuthenticateScheme = name
    return this
  }

  mapUser(mapper: PrincipalMapper | string | symbol): this {
    this.#mapper = mapper
    return this
  }

  build(): { coordinator: AuthenticationCoordinator, options: AuthenticationOptions } {
    const opts = this.#options
    const firstScheme = this.#schemes.keys().next().value as string | undefined

    const options: AuthenticationOptions = {
      defaultAuthenticateScheme: opts.defaultAuthenticateScheme ?? firstScheme ?? '',
    }

    const schemes = new Map<string, Provider<AuthenticationHandler>>()
    for (const [name, keyOrHandler] of this.#schemes) {
      const handler: Provider<AuthenticationHandler> = isConstructable(keyOrHandler)
        ? this.#container.wrap(keyOrHandler)
        : { get: () => keyOrHandler as AuthenticationHandler }
      schemes.set(name, handler)
    }

    const mapper = this.#mapper === undefined
      ? undefined
      : typeof this.#mapper === 'string' || typeof this.#mapper === 'symbol'
        ? this.#container.wrap<PrincipalMapper>(this.#mapper)
        : { get: () => this.#mapper as PrincipalMapper }
    const schemeProvider = new AuthenticationSchemeProvider(schemes, options)
    const service = new AuthenticationCoordinator(schemeProvider, mapper)

    for (const [, handler] of schemes) {
      if (handler instanceof ForwardAuthenticationHandler) {
        handler.setSchemeProvider(schemeProvider)
      }
    }

    this.#container.bind(AuthenticationCoordinator).toValue(service)
    this.#container.bind(kAuthOpts).toValue(options)

    return { coordinator: service, options }
  }
}

function isConstructable<T>(value: unknown): value is Ctor<T> {
  return typeof value === 'function' && value.prototype !== undefined && value.prototype.constructor === value
}
