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

/**
 * The teardown did not finish inside the shutdown budget. Whatever it was still waiting on was cut, so the
 * process can report the overrun instead of being taken out mid-sentence by the orchestrator's `SIGKILL`.
 */
export class ErrShutdownTimeout extends ErrCaffeine {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`Cannot complete graceful shutdown: teardown did not finish within ${timeoutMs}ms`, 'ERR_SHUTDOWN_TIMEOUT')
    this.timeoutMs = timeoutMs
  }
}
