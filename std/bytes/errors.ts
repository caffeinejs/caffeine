import { errMessage } from '../err/index.js'

/** A value reached `parseBytes` or `bytes` that the grammar does not accept, or one that is not a whole number of bytes. */
export class ErrInvalidByteSize extends Error {
  readonly code = 'ERR_INVALID_BYTE_SIZE'

  constructor(value: number | string, reason: string) {
    super(
      errMessage(`Cannot parse byte size "${value}": ${reason}`)
        .reference('@caffeinejs/std', ErrInvalidByteSize)
        .build(),
    )
    this.name = 'ErrInvalidByteSize'
  }
}
