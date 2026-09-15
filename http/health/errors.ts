import { ErrCaffeineWebApplication } from '../error/common.js'

/** A health configuration that cannot produce a correct shutdown, detected at `ready()`. */
export class ErrHealthConfiguration extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_HEALTH_CONFIGURATION')
    this.name = 'ErrHealthConfiguration'
  }
}

/** A health indicator bound with a lifetime other than singleton, detected at `ready()`. */
export class ErrHealthIndicatorNotSingleton extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_HEALTH_INDICATOR_NOT_SINGLETON')
    this.name = 'ErrHealthIndicatorNotSingleton'
  }
}
