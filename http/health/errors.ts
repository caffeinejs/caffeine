import { ErrCaffeineWebApplication } from '../error/common.js'

/** A health setting that cannot work — a probe path some other route owns, a budget of 0 — detected at `ready()`. */
export class ErrHealthConfiguration extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_HEALTH_CONFIGURATION')
    this.name = 'ErrHealthConfiguration'
  }
}
