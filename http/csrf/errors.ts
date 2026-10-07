import { ErrCaffeineWebApplication } from '../error/common.js'
import { ErrHTTPForbidden } from '../error/http.js'
import type { OriginReason } from './origin.js'

/**
 * A request cross-origin protection refused: a 403 with the code `ERR_CSRF_CROSS_ORIGIN`. `reason` says what decided
 * it. The message never carries a header value.
 *
 * The deny handler is `@Catch(ErrCSRFCrossOrigin)`, or one enrolled with `.errorHandling(e => e.globalHandlers(...))`.
 */
export class ErrCSRFCrossOrigin extends ErrHTTPForbidden {
  readonly reason: OriginReason

  constructor(reason: OriginReason) {
    super('Cannot accept the request: it is cross-origin', { code: 'ERR_CSRF_CROSS_ORIGIN' })
    this.name = 'ErrCSRFCrossOrigin'
    this.reason = reason
  }
}

/**
 * Refuses a `csrf()` setting at start-up: a trusted origin that is not one, an excluded path not starting with `/`,
 * or `/` itself.
 */
export class ErrCSRFConfiguration extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_CSRF_CONFIGURATION')
    this.name = 'ErrCSRFConfiguration'
  }
}
