import type { EmitLevel, Logger } from './logger.js'

const noop = () => {
  // Writes nothing.
}

/**
 * Writes nothing, anywhere.
 *
 * `LoggerBuilder.disable()` and `ApplicationOptions.logger: false` both resolve to this — disabling never
 * means an absent logger.
 */
const noopLogger: Logger = {
  level: 'silent',
  levels: { values: {} as Record<EmitLevel, number>, labels: {} },
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  silent: noop,
  isLevelEnabled: () => false,
  bindings: () => ({}),
  child: () => noopLogger,
  flush: cb => cb?.(),
}

/** A {@link Logger} that writes nothing, anywhere. */
export function newNoopLogger(): Logger {
  return noopLogger
}

export { noopLogger }
