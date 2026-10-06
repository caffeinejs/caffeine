import type { CookieSecret } from './signer.js'

/** The `SameSite` values, as the attribute takes them. */
export type CookieSameSite = 'strict' | 'lax' | 'none'

/** The `Priority` values a browser understands. */
export type CookiePriority = 'low' | 'medium' | 'high'

/**
 * What `ctx.cookie(...)` and `ctx.deleteCookie(...)` take, over the server's `parseOptions`.
 *
 * A cookie nobody scoped goes out with `Path=/` and `SameSite=Lax`. An option written as `undefined` clears what the
 * defaults set.
 */
export interface CookieSerializeOptions {
  domain?: string

  /** Defaults to `/`. Under a base path, scope a cookie to the application with `ctx.req.basePath || '/'`. */
  path?: string

  /** A date, or milliseconds since the epoch. */
  expires?: Date | number

  /** Seconds. */
  maxAge?: number

  httpOnly?: boolean

  /**
   * `'auto'` sets `Secure` when the request came over HTTPS, as `request.protocol` reports it, so behind a proxy it
   * follows `trustProxy`. On a plain-HTTP request it also sends `SameSite=None` as `Lax`, which a browser would drop
   * otherwise. A `__Secure-` or `__Host-` name, or `partitioned`, has no such fallback: on a plain-HTTP request it is
   * refused.
   *
   * A browser takes `Secure` from `http://localhost`, so `true` serves local development as well.
   */
  secure?: boolean | 'auto'

  /** Defaults to `lax`. `true` is `strict`; `false` leaves the attribute off. */
  sameSite?: boolean | CookieSameSite

  /** Keeps the cookie apart per top-level site (CHIPS). Requires `Secure`. */
  partitioned?: boolean

  priority?: CookiePriority

  /** Encodes the value. Mirror it with the server's `decode`. */
  encode?: (value: string) => string

  /** Signs the value with the server's signer. */
  signed?: boolean

  /**
   * Signs the value with this secret instead of the server's, whatever `signed` says. An array signs with its first
   * entry. Read it back with the same secret: `ctx.req.signedCookie(name, secret)`.
   */
  secret?: CookieSecret
}

/** What every cookie a server sets starts from, and how it decodes the ones it reads. */
export interface CookieParseOptions extends Omit<CookieSerializeOptions, 'secret'> {
  /**
   * Decodes a value read from a request. Defaults to `decodeURIComponent`, keeping the raw value when it fails.
   *
   * Returning `undefined` leaves the cookie out. The first cookie of a name decides, so a later one of the same name is
   * not read in its place.
   */
  decode?: (value: string) => string | undefined
}
