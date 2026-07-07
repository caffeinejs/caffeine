import type { Principal } from '../principal.js'

export class AuthenticationProperties {
  readonly #items: Map<string, unknown>

  constructor(items?: Map<string, unknown>) {
    this.#items = items ?? new Map()
  }

  get items(): ReadonlyMap<string, unknown> {
    return this.#items
  }
}

export class AuthenticationTicket {
  readonly #principal: Principal
  readonly #scheme: string
  readonly #properties: AuthenticationProperties

  constructor(principal: Principal, scheme: string, properties?: AuthenticationProperties) {
    this.#principal = principal
    this.#scheme = scheme
    this.#properties = properties ?? new AuthenticationProperties()
  }

  get principal(): Principal {
    return this.#principal
  }

  get scheme(): string {
    return this.#scheme
  }

  get properties(): AuthenticationProperties {
    return this.#properties
  }
}

export class AuthenticateResult {
  private constructor(
    readonly ticket?: AuthenticationTicket,
    readonly error?: Error,
  ) {}

  get succeeded(): boolean {
    return this.ticket !== undefined
  }

  static none(): AuthenticateResult {
    return new AuthenticateResult()
  }

  static success(ticket: AuthenticationTicket): AuthenticateResult {
    return new AuthenticateResult(ticket)
  }

  static fail(error: Error): AuthenticateResult {
    return new AuthenticateResult(undefined, error)
  }
}
