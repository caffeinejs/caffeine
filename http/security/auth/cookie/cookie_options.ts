import type { Context } from '../../../context.js'

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
  /** Path to redirect to on challenge for browser apps. When unset, challenge returns a bare 401. */
  loginPath?: string
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

  loginPath(path: string): this {
    this.#options.loginPath = path
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

    return {
      sessionSecret: this.#options.sessionSecret,
      cookieName: this.#options.cookieName ?? 'caf.session',
      rememberMe: this.#options.rememberMe ?? false,
      rememberMeCookieName: this.#options.rememberMeCookieName ?? 'caf.remember',
      loginPath: this.#options.loginPath,
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
