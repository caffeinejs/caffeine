import type { InjectionToken } from '@caffeinejs/di'
import { FeatureBuilder, kFeatureName } from '@caffeinejs/std'

import { kServerExtension, type FastifyExtension } from '../plugin.js'
import type { CookieParseOptions } from './options.js'
import { cookiePlugin, type CookiePluginOptions } from './plugin.js'
import type { CookieSecret, CookieSigner, CookieSigningAlgorithm } from './signer.js'

/** How the cookie feature sets up every server's cookies. */
export interface CookieOptions {
  /** Whether servers handle cookies at all. Off leaves them without: reading or setting one throws. */
  enabled: boolean
  /**
   * The secret signed cookies are signed with. An array rotates secrets: the first signs, and any of them verifies.
   * Each must be at least 32 characters.
   */
  secret?: CookieSecret
  /** The HMAC hash the secret signs with. Defaults to `SHA-256`. */
  algorithm?: CookieSigningAlgorithm
  /** What every cookie a server sets starts from, and how cookies read from a request are decoded. */
  parseOptions?: CookieParseOptions
}

/**
 * Configures the cookies every application gets.
 *
 * The feature is registered unconditionally and installs ahead of everything `.with(...)` registers, on the
 * application's server and on every ops server, each with a signer of its own resolved once as the server starts.
 * Cookies are parsed when first read, so no plugin reading one — the authentication gate included — has an order to
 * get right. The `Set-Cookie` writer runs ahead of every later plugin's `onSend` hook.
 *
 * What a fluent method sets is final. To let the environment carry the secret, declare a block of
 * {@link CookieOptions} in the application's schema and hand its node over:
 *
 * ```ts
 * .cookie((k, { config }) => k.config(config.app.cookie))
 * ```
 *
 * An application whose own server registers `@fastify/cookie`, for a plugin that needs it, keeps both: the context's
 * cookies are this feature's, and that plugin's decorations are its own.
 */
export class CookieBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'cookie'

  #config: Partial<CookieOptions> | undefined
  #enabled: boolean | undefined
  #secret: CookieSecret | undefined
  #signer: CookieSigner | InjectionToken<CookieSigner> | undefined
  #algorithm: CookieSigningAlgorithm | undefined
  #parseOptions: CookieParseOptions | undefined

  /**
   * Reads the settings from a node of the configuration tree, e.g. `config.app.cookie`.
   *
   * The node is read once, when each server is wired. A fluent method wins over what the node carries, and a
   * {@link signer} over the node's secret.
   */
  config(config: Partial<CookieOptions>): this {
    this.#config = config
    return this
  }

  /**
   * Turns cookies off, which leaves every server without them: reading or setting one throws `ErrCookiesDisabled`
   * rather than answering nothing, and a scheme that keeps its session in a cookie refuses to start.
   */
  enabled(enabled: boolean): this {
    this.#enabled = enabled
    return this
  }

  /**
   * The secret signed cookies are signed with. An array rotates: the first signs, and any of them verifies.
   *
   * @throws ErrCookieConfiguration when the server starts, if a secret is shorter than 32 characters or a
   * {@link signer} is set too.
   */
  secret(secret: CookieSecret): this {
    this.#secret = secret
    return this
  }

  /**
   * Signs with a signer of the application's own, given as the instance or as the container key it resolves from.
   * A key is resolved once per server, as it starts.
   *
   * @throws ErrCookieConfiguration when the server starts, if the key resolves to nothing or a {@link secret} is set
   * too.
   */
  signer(signer: CookieSigner | InjectionToken<CookieSigner>): this {
    this.#signer = signer
    return this
  }

  /** The HMAC hash a {@link secret} signs with, and a secret handed to a single call. Defaults to `SHA-256`. */
  algorithm(algorithm: CookieSigningAlgorithm): this {
    this.#algorithm = algorithm
    return this
  }

  /** What every cookie a server sets starts from, and how cookies read from a request are decoded. */
  parseOptions(options: CookieParseOptions): this {
    this.#parseOptions = options
    return this
  }

  /** The plugin half. The application puts it in a head slot ahead of everything `.with(...)` registers. */
  readonly [kServerExtension] = (): FastifyExtension => cookiePlugin(this.#settings())

  #settings(): CookiePluginOptions {
    return {
      enabled: this.#enabled ?? this.#config?.enabled ?? true,
      signer: this.#signer,
      // A signer written in code is the last word over a secret the configuration carries.
      secret: this.#secret ?? (this.#signer === undefined ? this.#config?.secret : undefined),
      algorithm: this.#algorithm ?? this.#config?.algorithm,
      parseOptions: this.#parseOptions ?? this.#config?.parseOptions,
    }
  }
}
