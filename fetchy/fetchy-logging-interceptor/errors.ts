import { FetchyError } from '@caffeinejs/fetchy'

/**
 * Thrown when `redactHeader()` is called with no header names to redact.
 */
export class ErrFetchyLoggingInvalidRedactHeaderArgs extends FetchyError {
  constructor() {
    super(
      'Cannot redact headers: at least one header name is required',
      'ERR_FETCHY_LOGGING_INVALID_REDACT_HEADER_ARGS',
    )
    this.name = 'ErrFetchyLoggingInvalidRedactHeaderArgs'
  }
}
