import { ErrCaffeineWebApplication } from '../error/common.js'

/** A probe path some other route already owns, detected at `ready()`. */
export class ErrHealthConfiguration extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_HEALTH_CONFIGURATION')
    this.name = 'ErrHealthConfiguration'
  }
}
