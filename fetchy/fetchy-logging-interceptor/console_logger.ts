import type { Logger } from './logger.js'

/**
 * Plain `console`-backed {@link Logger}, one line per call. Works in a browser console or a
 * terminal alike.
 */
export class ConsoleLogger implements Logger {
  info(message: string): void {
    console.info(message)
  }

  error(message: string, error?: Error): void {
    if (error) {
      console.error(message, error)
      return
    }

    console.error(message)
  }
}
