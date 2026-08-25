import type { Context } from '../../../context.js'
import type { Principal } from '../../index.js'
import { type ChallengeMode, MIN_SESSION_SECRET_LENGTH } from '../internal/remote/config.js'

export type CookieSameSite = 'strict' | 'lax' | 'none'

export interface CookieAuthenticationOptions {
  /** Secret used to derive the sealing key. Required. */
  sessionSecret: string | Uint8Array
  /** Cookie name. Default `'caf.session'`. */
  cookieName?: string
  /**
   * Enable durable, server-side-revocable remember-me (series + token). Requires a
   * `RememberMeTokenStore` and a `UserProvider` bound to the container. When off (default),
   * remember-me falls back to a persistent session cookie that cannot be revoked before expiry.
   */
  rememberMe?: boolean
  /** Remember-me cookie name (durable mode). Default `'caf.remember'`. */
  rememberMeCookieName?: string
  /**
   * How long a just-rotated remember-me token stays acceptable, in seconds. Default 60.
   *
   * Rotation is single-use, so a superseded token normally means theft. But a browser fires requests in
   * parallel and every one of them carries the cookie as it stood when the batch began, so without a
   * window the first response to rotate turns its own siblings into apparent thefts. The window bounds
   * how long a spent token remains useful to someone who captured it; `0` disables the tolerance and
   * restores strict single-use.
   */
  rememberMeRotationGraceSeconds?: number
  /** Path to redirect to on challenge for browser apps. When unset, challenge returns a bare 401. */
  loginPath?: string
  /**
   * Whether a challenge redirects to {@link loginPath} or answers 401. Default `'auto'`.
   *
   * `auto` redirects a browser navigation and answers 401 to anything else, so a `fetch` gets a status it
   * can act on instead of the login page's HTML with a 200. See {@link ChallengeMode}.
   */
  challengeMode?: ChallengeMode
  /**
   * Where to send an authenticated caller whose authorization failed. When unset, `forbid` answers 403.
   *
   * Separate from {@link loginPath} on purpose: sending a signed-in user back to the login page to fix a
   * permissions problem produces a loop in which signing in again never helps.
   */
  accessDeniedPath?: string
  /** Query parameter carrying the post-login destination on the {@link loginPath} redirect. Default `'returnUrl'`. */
  returnURLParameter?: string
  /**
   * Decides, per request, whether a session carried by a valid cookie is still acceptable.
   *
   * Return the principal (or a refreshed replacement) to accept, `null` to reject and clear the cookie.
   * The sealed cookie is self-contained, so without this nothing that happens server-side — a password
   * change, a revoked account, a role removal — reaches a session already issued until it expires on its
   * own. ASP.NET's `CookieAuthenticationEvents.OnValidatePrincipal`; its security-stamp validation is an
   * implementation of exactly this hook.
   *
   * It runs on every authenticated request, so it should be cheap: a version/stamp comparison, not a full
   * user load.
   */
  validatePrincipal?: (ctx: Context, principal: Principal) => Promise<Principal | null> | Principal | null
  /** Overrides the default 403 on an authorization failure. Takes precedence over {@link accessDeniedPath}. */
  onForbid?: (ctx: Context) => Promise<void> | void
  /** Absolute session lifetime, in seconds, for a non-persistent (session) cookie. Default 8 hours. */
  maxAge?: number
  /** Absolute lifetime, in seconds, for a persistent (remember-me) cookie. Default 30 days. */
  rememberMeMaxAge?: number
  /** `Secure` cookie flag. Default `true`. */
  secure?: boolean
  /** `SameSite` cookie flag. Default `'lax'`. */
  sameSite?: CookieSameSite
  /** Cookie `Path`. Default `'/'`. */
  path?: string
  /** Claim type treated as the role claim on the rebuilt identity. Default `'roles'`. */
  roleClaimType?: string
  onChallenge?: (ctx: Context) => Promise<void> | void
}

const EIGHT_HOURS = 8 * 60 * 60
const THIRTY_DAYS = 30 * 24 * 60 * 60

export class CookieAuthenticationOptionsBuilder {
  readonly #options: Partial<CookieAuthenticationOptions> = {}

  sessionSecret(secret: string | Uint8Array): this {
    this.#options.sessionSecret = secret
    return this
  }

  cookieName(name: string): this {
    this.#options.cookieName = name
    return this
  }

  rememberMe(enable = true): this {
    this.#options.rememberMe = enable
    return this
  }

  rememberMeCookieName(name: string): this {
    this.#options.rememberMeCookieName = name
    return this
  }

  /** How long a just-rotated remember-me token stays acceptable. Default 60s; `0` is strict single-use. */
  rememberMeRotationGraceSeconds(seconds: number): this {
    this.#options.rememberMeRotationGraceSeconds = seconds
    return this
  }

  /** How a challenge is delivered: redirect a navigation, answer 401 to anything else. Default `'auto'`. */
  challengeMode(mode: ChallengeMode): this {
    this.#options.challengeMode = mode
    return this
  }

  loginPath(path: string): this {
    this.#options.loginPath = path
    return this
  }

  /** Where an authenticated-but-unauthorized caller is sent. Without it, `forbid` answers a bare 403. */
  accessDeniedPath(path: string): this {
    this.#options.accessDeniedPath = path
    return this
  }

  /** Query parameter carrying the post-login destination. Default `'returnUrl'`. */
  returnURLParameter(name: string): this {
    this.#options.returnURLParameter = name
    return this
  }

  /** Per-request session validation. Return `null` to reject and clear the cookie. See the option docs. */
  validatePrincipal(validate: NonNullable<CookieAuthenticationOptions['validatePrincipal']>): this {
    this.#options.validatePrincipal = validate
    return this
  }

  onForbid(onForbid: NonNullable<CookieAuthenticationOptions['onForbid']>): this {
    this.#options.onForbid = onForbid
    return this
  }

  maxAge(seconds: number): this {
    this.#options.maxAge = seconds
    return this
  }

  rememberMeMaxAge(seconds: number): this {
    this.#options.rememberMeMaxAge = seconds
    return this
  }

  secure(secure: boolean): this {
    this.#options.secure = secure
    return this
  }

  sameSite(sameSite: CookieSameSite): this {
    this.#options.sameSite = sameSite
    return this
  }

  path(path: string): this {
    this.#options.path = path
    return this
  }

  roleClaimType(type: string): this {
    this.#options.roleClaimType = type
    return this
  }

  onChallenge(onChallenge: NonNullable<CookieAuthenticationOptions['onChallenge']>): this {
    this.#options.onChallenge = onChallenge
    return this
  }

  build(): CookieAuthenticationOptions {
    if (this.#options.sessionSecret === undefined) {
      throw new Error('Cannot build CookieAuthenticationOptions: sessionSecret is required')
    }

    // The same HKDF-SHA256 into dir/A256GCM that the OAuth-family strategies seal their cookies with, so
    // the same floor applies: below it the derived key is brute-forceable and the session cookie is
    // forgeable. Enforced here rather than trusted to the caller because a short secret fails silently.
    if (this.#options.sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
      throw new Error(
        `Cannot build CookieAuthenticationOptions: sessionSecret must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
      )
    }

    return {
      sessionSecret: this.#options.sessionSecret,
      cookieName: this.#options.cookieName ?? 'caf.session',
      rememberMe: this.#options.rememberMe ?? false,
      rememberMeCookieName: this.#options.rememberMeCookieName ?? 'caf.remember',
      rememberMeRotationGraceSeconds: this.#options.rememberMeRotationGraceSeconds ?? 60,
      loginPath: this.#options.loginPath,
      challengeMode: this.#options.challengeMode ?? 'auto',
      accessDeniedPath: this.#options.accessDeniedPath,
      returnURLParameter: this.#options.returnURLParameter ?? 'returnUrl',
      validatePrincipal: this.#options.validatePrincipal,
      onForbid: this.#options.onForbid,
      maxAge: this.#options.maxAge ?? EIGHT_HOURS,
      rememberMeMaxAge: this.#options.rememberMeMaxAge ?? THIRTY_DAYS,
      secure: this.#options.secure ?? true,
      sameSite: this.#options.sameSite ?? 'lax',
      path: this.#options.path ?? '/',
      roleClaimType: this.#options.roleClaimType ?? 'roles',
      onChallenge: this.#options.onChallenge,
    }
  }
}
