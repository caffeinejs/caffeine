import { ErrCaffeineWebApplication } from '../error/common.js'

/**
 * A cookie setting that cannot work, refused at start-up: a secret too short, a signer and a secret both given, a
 * signer key nothing is bound to. Also a signature asked for when the server has nothing to sign with.
 */
export class ErrCookieConfiguration extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_COOKIE_CONFIGURATION')
    this.name = 'ErrCookieConfiguration'
  }
}

/** Cookies read or set where no cookie plugin serves them: on a server whose cookies are off, or on a route built before the plugin. */
export class ErrCookiesDisabled extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_COOKIES_DISABLED')
    this.name = 'ErrCookiesDisabled'
  }
}

/** A cookie a browser would drop or misread: a broken prefix rule, `SameSite=None` without `Secure`, a value too long. */
export class ErrInvalidCookie extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_INVALID_COOKIE')
    this.name = 'ErrInvalidCookie'
  }
}

/** A cookie set once it can no longer go out: after the response's headers, or, signed, after its cookies were written. */
export class ErrCookieTooLate extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_COOKIE_TOO_LATE')
    this.name = 'ErrCookieTooLate'
  }
}
