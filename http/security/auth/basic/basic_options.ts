import type { Context } from '../../../context.js'
import type { Principal } from '../../index.js'

export interface BasicAuthenticationOptions {
  realm?: string
  validate: (ctx: Context, username: string, password: string) => Promise<Principal | null> | Principal | null
  onFail?: (ctx: Context, error: Error) => Promise<void> | void
  onChallenge?: (ctx: Context) => Promise<void> | void
  onForbid?: (ctx: Context) => Promise<void> | void
}

export class BasicAuthenticationOptionsBuilder {
  readonly #options: Partial<BasicAuthenticationOptions> = {}

  realm(realm: string): this {
    this.#options.realm = realm
    return this
  }

  validate(validate: BasicAuthenticationOptions['validate']): this {
    this.#options.validate = validate
    return this
  }

  onFail(onFail: NonNullable<BasicAuthenticationOptions['onFail']>): this {
    this.#options.onFail = onFail
    return this
  }

  onChallenge(onChallenge: NonNullable<BasicAuthenticationOptions['onChallenge']>): this {
    this.#options.onChallenge = onChallenge
    return this
  }

  onForbid(onForbid: NonNullable<BasicAuthenticationOptions['onForbid']>): this {
    this.#options.onForbid = onForbid
    return this
  }

  build(): BasicAuthenticationOptions {
    if (!this.#options.validate) {
      throw new Error('Cannot build BasicAuthenticationOptions: validate is required')
    }

    return this.#options as BasicAuthenticationOptions
  }
}
