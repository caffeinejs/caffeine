import pino, { type Logger as PinoInstance, type LoggerOptions } from 'pino'

import type { Logger } from '../logger.js'

/**
 * A {@link Logger} backed by pino.
 *
 * Takes the options pino is built with, or an instance built elsewhere, such as the application's own: a destination,
 * serializers, redaction and a transport, such as pino-pretty's, are configured on pino, not here.
 */
export class PinoLogger implements Logger {
  /**
   * What `new PinoLogger()` builds pino with: JSON lines from `info` up, on stdout. They name no transport, so pino
   * alone builds them. For pino-pretty's output, pass options whose `transport` names it.
   */
  static readonly DEFAULT_OPTIONS: LoggerOptions = { level: 'info' }

  private readonly pino: PinoInstance

  constructor(options: LoggerOptions | PinoInstance = PinoLogger.DEFAULT_OPTIONS) {
    this.pino = isPinoInstance(options) ? options : pino(options)
  }

  info(message: string): void {
    this.pino.info(message)
  }

  /**
   * Logs `error`, when given, under `err`, where pino's standard serializer writes its type, message, stack, cause
   * and own properties, such as `code`.
   */
  error(message: string, error?: Error): void {
    if (error === undefined) {
      this.pino.error(message)
      return
    }

    this.pino.error({ err: error }, message)
  }
}

function isPinoInstance(options: LoggerOptions | PinoInstance): options is PinoInstance {
  return typeof (options as PinoInstance).child === 'function'
}
