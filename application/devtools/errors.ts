import { ErrCaffeine } from '../error.js'

/**
 * A resource a tool was asked for does not exist. The devtools answer `404` with the message, which is the response
 * body a client reads: it names what was asked for and nothing else.
 */
export class ErrDevToolNotFound extends ErrCaffeine {
  constructor(message: string) {
    super(message, 'ERR_DEVTOOL_NOT_FOUND')
  }
}

/**
 * A tool refused what it was handed. The devtools answer `400` with the message, which is the response body a client
 * reads.
 */
export class ErrDevToolInvalid extends ErrCaffeine {
  constructor(message: string) {
    super(message, 'ERR_DEVTOOL_INVALID')
  }
}
