import { ErrCaffeine } from '../error.js'

/** A health indicator bound with a lifetime other than singleton, detected when the probe service is built. */
export class ErrHealthIndicatorNotSingleton extends ErrCaffeine {
  constructor(message: string) {
    super(message, 'ERR_HEALTH_INDICATOR_NOT_SINGLETON')
  }
}
