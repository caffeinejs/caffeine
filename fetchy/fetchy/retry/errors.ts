import { errMessage } from '@caffeinejs/std/err'

import { ErrFetchy } from '../errors.js'

/** Thrown by `@Retry()` when its options cannot work, before any request is sent. */
export class ErrFetchyInvalidRetryOptions extends ErrFetchy {
  constructor(reason: string, ...solutions: string[]) {
    super(
      errMessage(`Cannot apply @Retry: ${reason}`)
        .solutions(...solutions)
        .reference('@caffeinejs/fetchy', ErrFetchyInvalidRetryOptions)
        .build(),
      'ERR_FETCHY_INVALID_RETRY_OPTIONS',
    )
    this.name = 'ErrFetchyInvalidRetryOptions'
  }
}
