import { Provider } from '@caffeinejs/di'

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

  /**
   * Every registered scheme name, in registration order. Lets a caller reject a reference to a scheme that was
   * never registered — a typo that would otherwise authorize nothing and say nothing.
   */
  get schemeNames(): readonly string[] {
    return [...this.#schemes.keys()]
  }

  get defaultAuthenticateScheme(): string {
    return this.#options.defaultAuthenticateScheme
  }

  get defaultChallengeScheme(): string {
    return this.#options.defaultChallengeScheme ?? this.#options.defaultAuthenticateScheme
  }

  get defaultForbidScheme(): string {
    return this.#options.defaultForbidScheme ?? this.#options.defaultAuthenticateScheme
  }
}
