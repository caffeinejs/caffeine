import type { Provider } from '@caffeinejs/di'

import type { Context } from '../../../context.js'
import { parseAuthorizationHeader } from '../authorization_header.js'
import { ErrAuthConfiguration } from '../errors.js'
import { BaseAuthenticationHandler } from '../handler.js'
import { challenge } from '../internal/challenge.js'
import { AuthenticateResult, type AuthenticationProperties, AuthenticationTicket } from '../ticket.js'
import type { OpaqueTokenAuthenticationOptions } from './opaque_options.js'
import type { OpaqueTokenStore } from './opaque_token_store.js'

/** RFC 9110 §5.6.2 `token`, which is what an authentication scheme is (§11.1). */
const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export class OpaqueTokenAuthenticationHandler extends BaseAuthenticationHandler<OpaqueTokenAuthenticationOptions> {
  readonly #name: string
  readonly #scheme: string

  #store!: Provider<OpaqueTokenStore>

  /**
   * @throws ErrAuthConfiguration when `options.scheme` is not an RFC 9110 token. It goes out as it is in every
   * challenge, and a header holding a space or a line break is one the server refuses to send.
   */
  constructor(name: string, options: OpaqueTokenAuthenticationOptions) {
    super(options)
    this.#name = name
    this.#scheme = options.scheme ?? 'Bearer'

    if (!HTTP_TOKEN.test(this.#scheme)) {
      throw new ErrAuthConfiguration(
        `Cannot configure authentication scheme "${name}": the scheme keyword "${this.#scheme}" is not a valid HTTP token`,
      )
    }
  }

  /**
   * Injected by the authentication builder at configure time (Forward-style), so container-bound
   * stores are resolved lazily rather than instantiated eagerly at registration.
   */
  setStore(store: Provider<OpaqueTokenStore>): void {
    this.#store = store
  }

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
    const token = parseAuthorizationHeader(ctx.req.header('authorization'), this.#scheme)
    if (token === undefined) {
      return AuthenticateResult.none()
    }

    let failure: Error
    try {
      const principal = await this.#store.get().validate(token, ctx)
      if (principal) {
        return AuthenticateResult.success(new AuthenticationTicket(principal, this.#name))
      }

      failure = new Error('Invalid token')
    } catch (e) {
      failure = e as Error
    }

    // Outside the `try`, so a hook that throws is not handed its own error to be called a second time with.
    await this.options.onFail?.(ctx, failure)

    return AuthenticateResult.fail(failure)
  }

  /**
   * Answers 401 with the scheme's challenge, and the realm when one is configured.
   *
   * Under the `Bearer` keyword a token that was presented and refused is named as such, `error="invalid_token"`
   * (RFC 6750 §3), so a client can tell a token that is no good any more from having sent none. Another keyword
   * has no registered parameter to say it with.
   */
  override async challenge(
    ctx: Context,
    _properties?: AuthenticationProperties,
    previous?: AuthenticateResult,
  ): Promise<void> {
    if (this.options.onChallenge) {
      return this.options.onChallenge(ctx)
    }

    const error = this.#isBearer && previous?.error !== undefined ? 'invalid_token' : undefined

    ctx.status(401).appendHeader('WWW-Authenticate', challenge(this.#scheme, { realm: this.options.realm, error }))
  }

  /** Answers 403, under the `Bearer` keyword with RFC 6750 §3.1 `insufficient_scope`: a good token, not enough. */
  override async forbid(ctx: Context): Promise<void> {
    if (this.options.onForbid) {
      return this.options.onForbid(ctx)
    }

    ctx.status(403)

    if (this.#isBearer) {
      ctx.appendHeader(
        'WWW-Authenticate',
        challenge(this.#scheme, { realm: this.options.realm, error: 'insufficient_scope' }),
      )
    }
  }

  get #isBearer(): boolean {
    return this.#scheme.toLowerCase() === 'bearer'
  }
}
