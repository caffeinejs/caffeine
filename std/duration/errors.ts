import { errMessage } from '../err/index.js'

/** A value reached `parseDuration` or `duration` that the grammar does not accept, or one out of range. */
export class ErrInvalidDuration extends Error {
  readonly code = 'ERR_INVALID_DURATION'

  constructor(value: number | string, reason: string) {
    super(
      errMessage(`Cannot parse duration "${value}": ${reason}`)
        .reference('@caffeinejs/std', ErrInvalidDuration)
        .build(),
    )
    this.name = 'ErrInvalidDuration'
  }
}
