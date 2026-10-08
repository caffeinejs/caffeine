import { ErrCaffeine } from '../error.js'
import { errMessage } from '../framework/err/index.js'

/** A value reached `bytes` that its grammar does not accept, or one whose size cannot be held exactly. */
export class ErrInvalidByteSize extends ErrCaffeine {
  constructor(value: number | string, reason: string) {
    super(
      errMessage(`Cannot parse byte size "${value}": ${reason}`)
        .reference('@caffeinejs/std', ErrInvalidByteSize)
        .build(),
      'ERR_INVALID_BYTE_SIZE',
    )
  }
}
