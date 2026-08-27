import type { Principal } from '../index.js'

/**
 * State that travels with a sign-in, a challenge, or a sign-out.
 *
 * The caller frequently knows something about the operation that the handler cannot work out for itself.
 * Where to send the user after they sign in, whether this session should outlive the browser, when it
 * should expire regardless.
 *
 * The interface has always accepted a `properties` bag on `challenge`/`forbid`/`revoke`, but nothing read
 * it — every handler narrowed the parameter away — so the only way to express "come back to /reports after
 * login" was to reimplement the challenge. The fields below are the ones handlers actually honour;
 * anything else belongs in {@link items}.
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
  /** Whether the session should survive the browser closing. Cookie schemes write a `Max-Age` when set. */
  isPersistent?: boolean
  /** Absolute expiry for the issued session, overriding the scheme's configured lifetime. */
  expiresUTC?: Date
  /** Whether the session may be refreshed/slid forward. */
  allowRefresh?: boolean
  /** Arbitrary caller state, round-tripped verbatim. */
  items?: Record<string, string>
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
