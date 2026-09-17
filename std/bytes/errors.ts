import { ErrCaffeine } from '../error.js'

/** A value reached `bytes` that its grammar does not accept, or one whose size cannot be held exactly. */
export class ErrInvalidByteSize extends ErrCaffeine {
  constructor(value: number | string, reason: string) {
    super(`Cannot parse byte size "${value}": ${reason}`, 'ERR_INVALID_BYTE_SIZE')
  }
}
