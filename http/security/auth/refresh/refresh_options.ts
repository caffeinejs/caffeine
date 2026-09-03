import type { JWTPayload } from 'jose'

import type { Principal } from '../../index.js'
import type { RefreshTokenRecord } from './refresh_token_store.js'

/**
 * Reloads the principal for a refreshing subject. Kept pluggable and IdP-agnostic: a BFF fronting an
 * upstream OAuth provider performs the upstream refresh here and returns fresh claims. Return null to
 * reject the refresh (unknown/disabled user) — the series is then revoked.
 */
export type RefreshPrincipalResolver = (
  subject: string,
  record: RefreshTokenRecord,
) => Promise<Principal | null> | Principal | null

export interface RefreshTokenOptions {
  resolve: RefreshPrincipalResolver
  /** Access-token lifetime. Number is seconds; string is a duration ('15m'). Default '15m'. */
  accessTTL?: string | number
  /** Refresh-token lifetime. Number is seconds; string is a duration ('30d'). Default '30d'. */
  refreshTTL?: string | number
  /** Maps the reloaded principal to the access-token payload. Default: every claim as `type: value`. */
  claims?: (principal: Principal) => JWTPayload
}

export class RefreshTokenOptionsBuilder {
  readonly #options: Partial<RefreshTokenOptions> = {}

  resolve(resolver: RefreshPrincipalResolver): this {
    this.#options.resolve = resolver
    return this
  }

  accessTTL(ttl: string | number): this {
    this.#options.accessTTL = ttl
    return this
  }

  refreshTTL(ttl: string | number): this {
    this.#options.refreshTTL = ttl
    return this
  }

  claims(claims: (principal: Principal) => JWTPayload): this {
    this.#options.claims = claims
    return this
  }

  build(): RefreshTokenOptions {
    if (this.#options.resolve == null) {
      throw new Error('Cannot configure refresh tokens: a "resolve" principal resolver is required')
    }

    return this.#options as RefreshTokenOptions
  }
}
