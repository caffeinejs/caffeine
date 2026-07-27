import pino, { type LoggerOptions } from 'pino'

import type { Logger } from './logger.js'

export class PinoLogger implements Logger {
  static readonly DEFAULT_OPTIONS: LoggerOptions = {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      worker: { autoEnd: true },
      options: {
        colorize: true,
        messageFormat: '{msg}',
        translateTime: true,
        ignore: 'hostname',
      },
    },
  }

  private readonly pino: pino.Logger

  constructor(options: LoggerOptions = PinoLogger.DEFAULT_OPTIONS) {
    this.pino = pino(options)
  }

  info(message: string): void {
    this.pino.info(message)
  }

  error(message: string): void {
    this.pino.error(message)
  }
}
