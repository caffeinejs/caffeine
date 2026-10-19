import type { Bindings, LevelMapping, LogFn, Logger } from '@caffeinejs/application/logger'

/** One record a {@link RecordingLogger} was asked to write, with the bindings of the logger it went through. */
export interface Written {
  severity: string
  args: unknown[]
  bindings: Bindings
}

/**
 * A `Logger` that keeps what it was asked to write. A child shares the records and tags what it writes with its
 * bindings, so a record written through `request.log`, the child Fastify makes with a `reqId`, is told apart from
 * one written on the logger itself.
 */
export class RecordingLogger implements Logger {
  level = 'trace'
  readonly levels: LevelMapping = {
    values: { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 },
    labels: { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' },
  }

  readonly written: Written[]
  readonly #bindings: Bindings

  readonly trace = this.#record('trace')
  readonly debug = this.#record('debug')
  readonly info = this.#record('info')
  readonly warn = this.#record('warn')
  readonly error = this.#record('error')
  readonly fatal = this.#record('fatal')
  readonly silent = this.#record('silent')

  constructor(written: Written[] = [], bindings: Bindings = {}) {
    this.written = written
    this.#bindings = bindings
  }

  isLevelEnabled(): boolean {
    return true
  }

  bindings(): Bindings {
    return this.#bindings
  }

  child(bindings: Bindings): Logger {
    return new RecordingLogger(this.written, { ...this.#bindings, ...bindings })
  }

  flush(): void {
    // Nothing is buffered.
  }

  #record(severity: string): LogFn {
    return (...args: unknown[]): void => {
      this.written.push({ severity, args, bindings: this.#bindings })
    }
  }
}
