import type { Principal } from '../index.js'

/**
 * What the caller of a sign-in or a challenge knows and the handler cannot work out for itself: where to send the
 * user afterwards, whether the session should outlive the browser.
 */
export interface AuthenticationProperties {
  /**
   * Where to send the user once the operation completes.
   *
   * Cookie sign-in uses it as the `returnUrl` on the login redirect; the OAuth-family strategies use it as
   * the post-callback destination instead of the URL the challenge happened to interrupt. Always
   * revalidated against the same-origin rule before use — a caller-supplied redirect target is exactly the
   * shape of an open redirect.
   */
  redirectURI?: string
  /**
   * Whether the session should survive the browser closing. The cookie scheme writes a `Max-Age` when set, or
   * issues a durable remember-me credential when it has a store for one.
   */
  isPersistent?: boolean
}

export class AuthenticationTicket {
  constructor(
    readonly principal: Principal,
    readonly scheme: string,
    readonly properties?: AuthenticationProperties,
  ) {}
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
