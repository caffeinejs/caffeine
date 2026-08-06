import type { Provider } from '@caffeinejs/di'
import type { Context } from '../../../context.js'
import { BaseAuthenticationHandler } from '../handler.js'
import { AuthenticateResult, AuthenticationTicket } from '../ticket.js'
import type { OpaqueTokenAuthenticationOptions } from './opaque_options.js'
import type { OpaqueTokenStore } from './opaque_token_store.js'

export class OpaqueTokenAuthenticationHandler extends BaseAuthenticationHandler<OpaqueTokenAuthenticationOptions> {
  readonly #name: string
  readonly #scheme: string

  #store!: Provider<OpaqueTokenStore>

  constructor(name: string, options: OpaqueTokenAuthenticationOptions) {
    super(options)
    this.#name = name
    this.#scheme = options.scheme ?? 'Bearer'
  }

  /**
   * Injected by the authentication builder at configure time (Forward-style), so container-bound
   * stores are resolved lazily rather than instantiated eagerly at registration.
   */
  setStore(store: Provider<OpaqueTokenStore>): void {
    this.#store = store
  }

  async authenticate(ctx: Context): Promise<AuthenticateResult> {
    const authHeader = ctx.req.header('authorization')
    const prefix = `${this.#scheme} `
    if (!authHeader?.startsWith(prefix)) {
      return AuthenticateResult.none()
    }

    const token = authHeader.slice(prefix.length).trim()
    if (token === '') {
      return AuthenticateResult.none()
    }

    try {
      const principal = await this.#store.get().validate(token, ctx)
      if (!principal) {
        const err = new Error('Invalid token')
        await this.options.onFail?.(ctx, err)
        return AuthenticateResult.fail(err)
      }

      return AuthenticateResult.success(new AuthenticationTicket(principal, this.#name))
    } catch (e) {
      await this.options.onFail?.(ctx, e as Error)
      return AuthenticateResult.fail(e as Error)
    }
  }

  override async challenge(ctx: Context): Promise<void> {
    if (this.options.onChallenge) {
      return this.options.onChallenge(ctx)
    }

    ctx.status(401).header('WWW-Authenticate', `${this.#scheme} realm="${this.options.realm ?? ''}"`)
  }

  override async forbid(ctx: Context): Promise<void> {
    if (this.options.onForbid) {
      return this.options.onForbid(ctx)
    }

    ctx.status(403)
  }
}
