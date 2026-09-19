import type { Bindings, EmitLevel, LevelMapping, LogFn, Logger } from '../../logger/logger.js'

export interface LogRecord {
  readonly level: EmitLevel
  readonly fields: Record<string, unknown>
  readonly msg: string
  /** Everything the logger and its ancestors were bound with, e.g. `{ name: 'config' }` for the child. */
  readonly bindings: Bindings
}

const LEVELS: LevelMapping = {
  values: { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 },
  labels: { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' },
}

/** A logger that keeps every record, at every level, shared with every child it derives. */
export class RecordingLogger implements Logger {
  level = 'trace'
  readonly levels = LEVELS
  readonly records: LogRecord[]

  readonly #bindings: Bindings

  readonly trace = this.#writer('trace')
  readonly debug = this.#writer('debug')
  readonly info = this.#writer('info')
  readonly warn = this.#writer('warn')
  readonly error = this.#writer('error')
  readonly fatal = this.#writer('fatal')
  readonly silent: LogFn = () => undefined

  constructor(bindings: Bindings = {}, records: LogRecord[] = []) {
    this.#bindings = bindings
    this.records = records
  }

  /** The records written at `level`, by this logger or any child of it. */
  at(level: EmitLevel): LogRecord[] {
    return this.records.filter(record => record.level === level)
  }

  isLevelEnabled(): boolean {
    return true
  }

  bindings(): Bindings {
    return this.#bindings
  }

  child(bindings: Bindings): Logger {
    return new RecordingLogger({ ...this.#bindings, ...bindings }, this.records)
  }

  flush(cb?: (err?: Error) => void): void {
    cb?.()
  }

  #writer(level: EmitLevel): LogFn {
    return ((obj: unknown, msg?: string) => {
      const [fields, message] =
        typeof obj === 'string' ? [{}, obj] : [(obj ?? {}) as Record<string, unknown>, msg ?? '']
      this.records.push({ level, fields, msg: message, bindings: this.#bindings })
    }) as LogFn
  }
}
