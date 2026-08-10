import type { JWTPayload } from 'jose'
import { ErrHTTPUnauthorized } from '../../../error/http.js'
import type { Principal } from '../../index.js'
import { JWTService } from '../jwt/jwt_service.js'
import { formatToken, hashToken, newSeries, newToken, parseToken, tokenMatches } from '../internal/series_token.js'
import type { RefreshPrincipalResolver, RefreshTokenOptions } from './refresh_options.js'
import type { RefreshTokenStore } from './refresh_token_store.js'

/** Thrown when a presented refresh token is missing, unknown, expired, rotated-away, or revoked. */
export class ErrRefreshTokenRejected extends ErrHTTPUnauthorized {
  constructor(message: string = 'Refresh token rejected') {
    super(message, { code: 'ERR_REFRESH_TOKEN_REJECTED' })
    this.name = 'ErrRefreshTokenRejected'
  }
}

export interface RefreshTokenPair {
  /** Signed access JWT. */
  accessToken: string
  /** Opaque `series:token` refresh credential. Rotated on every {@link RefreshTokenService.refresh}. */
  refreshToken: string
  /** Access-token lifetime, echoed for the client (seconds or a duration string). */
  expiresIn: string | number
}

const DEFAULT_ACCESS_TTL = '15m'
const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60

/**
 * Bearer refresh-token grant: issues an access JWT paired with a durable, server-side, rotating
 * refresh token, and exchanges a refresh token for a fresh pair. Transport-agnostic — the caller
 * decides how the tokens travel (JSON body, header). Reuses the series+token model (rotate on use,
 * detect replay of a stale token as theft) shared with the cookie remember-me guard.
 */
export class RefreshTokenService {
  readonly #jwt: JWTService
  readonly #store: RefreshTokenStore
  readonly #resolve: RefreshPrincipalResolver
  readonly #accessTTL: string | number
  readonly #refreshTTLSeconds: number
  readonly #claims: (principal: Principal) => JWTPayload

  constructor(jwt: JWTService, store: RefreshTokenStore, options: RefreshTokenOptions) {
    this.#jwt = jwt
    this.#store = store
    this.#resolve = options.resolve
    this.#accessTTL = options.accessTTL ?? DEFAULT_ACCESS_TTL
    this.#refreshTTLSeconds = options.refreshTTL != null ? toSeconds(options.refreshTTL) : DEFAULT_REFRESH_TTL_SECONDS
    this.#claims = options.claims ?? defaultClaims
  }

  /** Mint a fresh access + refresh pair for an authenticated principal (login / guest issuance). */
  async issue(principal: Principal): Promise<RefreshTokenPair> {
    const subject = subjectOf(principal)
    const series = newSeries()
    const token = newToken()
    const expiresAt = nowSeconds() + this.#refreshTTLSeconds

    await this.#store.create({ series, subject, tokenHash: hashToken(token), expiresAt })
    const accessToken = await this.#jwt.sign(this.#claims(principal), { subject, expiresIn: this.#accessTTL })

    return { accessToken, refreshToken: formatToken(series, token), expiresIn: this.#accessTTL }
  }

  /**
   * Exchange a refresh token for a new pair: verifies + rotates the stored token, reloads the principal
   * via the resolver, and re-signs the access JWT. Rejects (and revokes the series) on a stale-token
   * replay (theft), an expired/unknown series, or a resolver that returns null.
   */
  async refresh(refreshToken: string): Promise<RefreshTokenPair> {
    const parsed = parseToken(refreshToken)
    if (!parsed) {
      throw new ErrRefreshTokenRejected()
    }

    const record = await this.#store.findBySeries(parsed.series)
    if (!record) {
      throw new ErrRefreshTokenRejected()
    }

    if (record.expiresAt <= nowSeconds()) {
      await this.#store.remove(parsed.series)
      throw new ErrRefreshTokenRejected()
    }

    // A live series presented with the wrong token means a stale/stolen token was replayed: revoke the
    // whole series so neither the thief nor the victim can use it again.
    if (!tokenMatches(parsed.token, record.tokenHash)) {
      await this.#store.remove(parsed.series)
      throw new ErrRefreshTokenRejected()
    }

    const principal = await this.#resolve(record.subject, record)
    if (!principal) {
      await this.#store.remove(parsed.series)
      throw new ErrRefreshTokenRejected()
    }

    const nextToken = newToken()
    const expiresAt = nowSeconds() + this.#refreshTTLSeconds
    await this.#store.updateToken(parsed.series, hashToken(nextToken), expiresAt)
    const accessToken = await this.#jwt.sign(this.#claims(principal), {
      subject: record.subject,
      expiresIn: this.#accessTTL,
    })

    return { accessToken, refreshToken: formatToken(parsed.series, nextToken), expiresIn: this.#accessTTL }
  }

  /** Revoke a single refresh credential (sign-out of one device). */
  async revoke(refreshToken: string): Promise<void> {
    const parsed = parseToken(refreshToken)
    if (parsed) {
      await this.#store.remove(parsed.series)
    }
  }

  /** Revoke every refresh credential a user holds ("log out everywhere"). */
  async revokeAllForSubject(subject: string): Promise<void> {
    await this.#store.removeBySubject(subject)
  }
}

function subjectOf(principal: Principal): string {
  const sub = principal.findFirst('sub')?.value
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new Error('Cannot issue a refresh token: principal has no "sub" claim')
  }

  return sub
}

function defaultClaims(principal: Principal): JWTPayload {
  const payload: JWTPayload = {}
  for (const claim of principal.claims()) {
    payload[claim.type] = claim.value
  }

  return payload
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

// Duration → seconds for the store's absolute `expiresAt`. `jose` parses the access-token duration on
// its own; this covers the refresh-token side.
function toSeconds(ttl: string | number): number {
  if (typeof ttl === 'number') {
    return ttl
  }

  const match = /^(\d+)\s*(s|m|h|d|w)$/.exec(ttl.trim())
  if (!match) {
    throw new Error(`Cannot parse refresh token duration: "${ttl}"`)
  }

  const value = Number(match[1])
  const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[match[2]]!
  return value * unit
}
