import type { JWTPayload } from 'jose'

import { ErrHTTPUnauthorized } from '../../../error/http.js'
import type { Principal } from '../../index.js'
import {
  newSeriesToken,
  parseToken,
  readSeriesToken,
  rotateSeriesToken,
  type SeriesTokenPolicy,
} from '../internal/series_token.js'
import { JWTService } from '../jwt/jwt_service.js'
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
 * decides how the tokens travel (JSON body, header). Shares the series+token model with the cookie scheme's
 * remember-me: rotate on use, and take a token spent twice for what it is.
 */
export class RefreshTokenService {
  readonly #jwt: JWTService
  readonly #store: RefreshTokenStore
  readonly #resolve: RefreshPrincipalResolver
  readonly #accessTTL: string | number
  readonly #policy: SeriesTokenPolicy
  readonly #claims: (principal: Principal) => JWTPayload

  constructor(jwt: JWTService, store: RefreshTokenStore, options: RefreshTokenOptions) {
    this.#jwt = jwt
    this.#store = store
    this.#resolve = options.resolve
    this.#accessTTL = options.accessTTL ?? DEFAULT_ACCESS_TTL
    this.#claims = options.claims ?? defaultClaims
    this.#policy = {
      idleSeconds: options.refreshTTL != null ? toSeconds(options.refreshTTL) : DEFAULT_REFRESH_TTL_SECONDS,
      absoluteSeconds: options.absoluteTTL != null ? toSeconds(options.absoluteTTL) : undefined,
      // Strict single use (RFC 9700 §4.14.2). A request that lost the race has no new refresh token to be handed,
      // so there is nothing a grace window could give it.
      graceSeconds: 0,
    }
  }

  /** Mint a fresh access + refresh pair for an authenticated principal (login / guest issuance). */
  async issue(principal: Principal): Promise<RefreshTokenPair> {
    const subject = subjectOf(principal)
    const accessToken = await this.#jwt.sign(this.#claims(principal), { subject, expiresIn: this.#accessTTL })

    const { record, token } = newSeriesToken(subject, this.#policy)
    await this.#store.create(record)

    return { accessToken, refreshToken: token, expiresIn: this.#accessTTL }
  }

  /**
   * Exchanges a refresh token for a new pair: reloads the principal through the resolver, signs the access JWT,
   * and only then spends the refresh token.
   *
   * A refresh token is good once. Presented a second time — by a thief, or by the client it was stolen from —
   * it revokes the whole family, the pair handed out in between included, so both have to sign in again.
   *
   * @throws ErrRefreshTokenRejected for a malformed, unknown, expired or replayed token, and when the resolver no
   * longer knows the subject. The message never says which.
   */
  async refresh(refreshToken: string): Promise<RefreshTokenPair> {
    const reading = await readSeriesToken(this.#store, refreshToken, this.#policy)
    if (reading.status !== 'current') {
      throw new ErrRefreshTokenRejected()
    }

    const { record } = reading

    const principal = await this.#resolve(record.subject, record)
    if (!principal) {
      await this.#store.remove(record.series)
      throw new ErrRefreshTokenRejected()
    }

    // Signed before the token is spent: a failure here must not leave the client holding a token that was rotated
    // away and nothing to replace it with.
    const accessToken = await this.#jwt.sign(this.#claims(principal), {
      subject: record.subject,
      expiresIn: this.#accessTTL,
    })

    const rotated = await rotateSeriesToken(this.#store, refreshToken, record, this.#policy)
    if (rotated.status !== 'rotated') {
      throw new ErrRefreshTokenRejected()
    }

    return { accessToken, refreshToken: rotated.token, expiresIn: this.#accessTTL }
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

/** Every claim as `type: value`, a type that appears more than once becoming the list of its values. */
function defaultClaims(principal: Principal): JWTPayload {
  // Nothing inherited: a claim typed `constructor` has not appeared before just because every object has one, and
  // one typed `__proto__` is a key like any other.
  const payload = Object.create(null) as JWTPayload

  for (const claim of principal.claims()) {
    if (!(claim.type in payload)) {
      payload[claim.type] = claim.value
      continue
    }

    const current = payload[claim.type]
    payload[claim.type] = Array.isArray(current) ? [...(current as unknown[]), claim.value] : [current, claim.value]
  }

  return payload
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
