import { ErrCaffeineWebApplication } from '../error/common.js'

/** A health configuration that cannot produce a correct shutdown, detected at `ready()`. */
export class ErrHealthConfiguration extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_HEALTH_CONFIGURATION')
    this.name = 'ErrHealthConfiguration'
  }
}

/** The graceful shutdown exceeded its budget and connections were closed by force. */
export class ErrShutdownTimeout extends ErrCaffeineWebApplication {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Cannot complete graceful shutdown: in-flight requests did not finish within ${timeoutMs}ms`, 'ERR_SHUTDOWN_TIMEOUT')
    this.name = 'ErrShutdownTimeout'
    this.timeoutMs = timeoutMs
  }
}
