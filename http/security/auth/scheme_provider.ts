import { Provider } from '@caffeinejs/core'
import type { AuthenticationOptions } from './builder.js'
import type { AuthenticationHandler } from './handler.js'

export class AuthenticationSchemeProvider {
  readonly #schemes: Map<string, Provider<AuthenticationHandler>>
  readonly #options: AuthenticationOptions

  constructor(schemes: Map<string, Provider<AuthenticationHandler>>, options: AuthenticationOptions) {
    this.#schemes = schemes
    this.#options = options
  }

  schemeFor(name: string): Provider<AuthenticationHandler> | undefined {
    return this.#schemes.get(name)
  }

  get defaultAuthenticateScheme(): string {
    return this.#options.defaultAuthenticateScheme
  }
}
