import { ErrCaffeine } from '../error.js'

/** A level outside the seven `LOG_LEVELS` reached an implementation that only supports those. */
export class ErrInvalidLogLevel extends ErrCaffeine {
  constructor(level: string) {
    super(
      `Cannot set log level "${level}": level must be one of trace, debug, info, warn, error, fatal, silent`,
      'ERR_INVALID_LOG_LEVEL',
    )
  }
}

/** A logger was provided when one was already configured — there is one slot. */
export class ErrLoggerAlreadyConfigured extends ErrCaffeine {
  constructor() {
    super(
      'Cannot configure logger: a logger has already been provided',
      'ERR_LOGGER_ALREADY_CONFIGURED',
      undefined,
      'Configure the logger once, through `.logger(l => l.use(...))` or `ApplicationOptions.logger`, not both',
    )
  }
}
