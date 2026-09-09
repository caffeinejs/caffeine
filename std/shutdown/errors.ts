import { ErrCaffeine } from '../error.js'

/**
 * A graceful-shutdown configuration that cannot produce a correct drain — a drain delay that does not fit in
 * the pod's termination grace period. Detected at `ready()`, while the logs are still being watched.
 */
export class ErrShutdownConfiguration extends ErrCaffeine {
  constructor(message: string) {
    super(message, 'ERR_SHUTDOWN_CONFIGURATION')
  }
}
