import { ErrFetchy } from '@caffeinejs/fetchy'

import { errMessage } from './_err_message.gen.js'

/**
 * Thrown when `redactHeader()` is called with no header names to redact.
 */
export class ErrFetchyLoggingInvalidRedactHeaderArgs extends ErrFetchy {
  constructor() {
    super(
      errMessage('Cannot redact headers: at least one header name is required')
        .reference('@caffeinejs/fetchy-logging-interceptor', ErrFetchyLoggingInvalidRedactHeaderArgs)
        .build(),
      'ERR_FETCHY_LOGGING_INVALID_REDACT_HEADER_ARGS',
    )
    this.name = 'ErrFetchyLoggingInvalidRedactHeaderArgs'
  }
}
