import type { InjectionToken } from '@caffeinejs/di'
import type { Context } from '../../../context.js'
import { OpaqueTokenStore } from './opaque_token_store.js'

export interface OpaqueTokenAuthenticationOptions {
  /**
   * The store that validates a raw token and resolves it to a `Principal`. A DI key (defaulting to
   * the `OpaqueTokenStore` abstract-class token) or an inline instance.
   */
  store: InjectionToken<OpaqueTokenStore> | OpaqueTokenStore
  /** HTTP authentication scheme keyword expected in the `Authorization` header. Defaults to `Bearer`. */
  scheme?: string
  realm?: string
  onFail?: (ctx: Context, error: Error) => Promise<void> | void
  onChallenge?: (ctx: Context) => Promise<void> | void
  onForbid?: (ctx: Context) => Promise<void> | void
}

export class OpaqueTokenAuthenticationOptionsBuilder {
  readonly #options: Partial<OpaqueTokenAuthenticationOptions> = {}

  store(store: InjectionToken<OpaqueTokenStore> | OpaqueTokenStore): this {
    this.#options.store = store
    return this
  }

  scheme(scheme: string): this {
    this.#options.scheme = scheme
    return this
  }

  realm(realm: string): this {
    this.#options.realm = realm
    return this
  }

  onFail(onFail: NonNullable<OpaqueTokenAuthenticationOptions['onFail']>): this {
    this.#options.onFail = onFail
    return this
  }

  onChallenge(onChallenge: NonNullable<OpaqueTokenAuthenticationOptions['onChallenge']>): this {
    this.#options.onChallenge = onChallenge
    return this
  }

  onForbid(onForbid: NonNullable<OpaqueTokenAuthenticationOptions['onForbid']>): this {
    this.#options.onForbid = onForbid
    return this
  }

  build(): OpaqueTokenAuthenticationOptions {
    return {
      ...this.#options,
      store: this.#options.store ?? OpaqueTokenStore,
    }
  }
}
