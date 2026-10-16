import { token, type InjectionToken } from '@caffeinejs/di'

import type { CookieParseOptions } from './options.js'
import type { CookieSecret, CookieSigner, CookieSigningAlgorithm } from './signer.js'

/** What the cookie plugin of one server runs on. */
export interface CookiePluginOptions {
  /** Off leaves the plugin unregistered: reading or setting a cookie then throws `ErrCookiesDisabled`. */
  enabled: boolean
  signer?: CookieSigner | InjectionToken<CookieSigner>
  /** Builds the HMAC signer. Refused together with {@link signer}. */
  secret?: CookieSecret
  /** The HMAC signer's hash. Refused together with {@link signer}. */
  algorithm?: CookieSigningAlgorithm
  parseOptions?: CookieParseOptions
}

export const kCookieSettings = token<CookiePluginOptions>(Symbol('caffeine:http:cookie-settings'))
