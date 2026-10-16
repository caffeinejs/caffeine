import type { AuthenticateResult } from './ticket.js'

/** What one authentication scheme did during a request. */
export class SchemeAuthentication {
  /**
   * The authenticate call for this scheme, in flight or settled.
   *
   * The promise is what is kept, not the value, so callers that ask while one is running coalesce onto it
   * instead of starting a second verification. A rejection is kept for the same reason: a scheme that failed
   * must fail identically for every caller in the request.
   */
  pending?: Promise<AuthenticateResult>

  /**
   * The result once it has settled, readable without awaiting.
   *
   * What a later phase of the request is handed when it needs to know how the scheme decided — a challenge
   * naming the reason a token was rejected reads it from here rather than the scheme keeping its own copy.
   */
  result?: AuthenticateResult
}

/**
 * What each authentication scheme decided for one request.
 *
 * A request authenticates more than once by design — the server-wide hook runs the default scheme, a route
 * naming its own schemes re-authenticates with those, and a handler holding the service can ask again — so
 * each scheme's outcome is recorded the first time it runs and reused after that. The alternative is a fresh
 * verification per call: a fresh JWKS fetch, a fresh store round trip, and a fresh run of whatever the
 * scheme does while reading a credential. The cookie scheme's durable remember-me rotates a single-use token
 * inside `authenticate`, so a second call would present the token the first one had just spent and the
 * scheme would read its own rotation as theft.
 *
 * Almost every request touches one scheme, so the first is held in a pair of fields and the map is allocated
 * only when a second one authenticates.
 */
export class AuthenticationState {
  #name?: string
  #first?: SchemeAuthentication
  #more?: Map<string, SchemeAuthentication>

  /** The record for `scheme`, created on first use. */
  for(scheme: string): SchemeAuthentication {
    if (this.#name === undefined) {
      this.#name = scheme
      return (this.#first = new SchemeAuthentication())
    }

    if (this.#name === scheme) {
      return this.#first!
    }

    const more = (this.#more ??= new Map())
    let entry = more.get(scheme)
    if (entry === undefined) {
      entry = new SchemeAuthentication()
      more.set(scheme, entry)
    }

    return entry
  }

  /** The record for `scheme` if it has one. Never creates one. */
  find(scheme: string): SchemeAuthentication | undefined {
    return this.#name === scheme ? this.#first : this.#more?.get(scheme)
  }
}
