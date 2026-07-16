import type { Principal } from '../index.js'

export class AuthenticationTicket {
  constructor(
    readonly principal: Principal, readonly scheme: string, readonly properties?: object) {}
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
