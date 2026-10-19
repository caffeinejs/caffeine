import pino, { type Logger as PinoInstance, type LoggerOptions } from 'pino'

import type { Bindings, ChildOptions, LevelMapping, LogFn, Logger } from '../logger.js'

/**
 * A {@link Logger} backed by Pino.
 *
 * Takes the options Pino is constructed with, or an instance built elsewhere — a transport, a destination,
 * serializers and redaction are all configured on Pino, not here.
 *
 * ```ts
 * new PinoLogger({ level: 'debug' })
 * new PinoLogger(pino({ level: 'debug' }, pino.destination('./app.log')))
 * ```
 */
export class PinoLogger implements Logger {
  readonly trace: LogFn
  readonly debug: LogFn
  readonly info: LogFn
  readonly warn: LogFn
  readonly error: LogFn
  readonly fatal: LogFn
  readonly silent: LogFn

  readonly #pino: PinoInstance

  constructor(options?: LoggerOptions | PinoInstance) {
    this.#pino = isPinoInstance(options) ? options : pino(options)
    this.trace = this.#pino.trace.bind(this.#pino)
    this.debug = this.#pino.debug.bind(this.#pino)
    this.info = this.#pino.info.bind(this.#pino)
    this.warn = this.#pino.warn.bind(this.#pino)
    this.error = this.#pino.error.bind(this.#pino)
    this.fatal = this.#pino.fatal.bind(this.#pino)
    this.silent = this.#pino.silent.bind(this.#pino)
  }

  get level(): string {
    return this.#pino.level
  }

  set level(level: string) {
    this.#pino.level = level
  }

  get levels(): LevelMapping {
    // Pino's own `values`/`labels` carry an open `string`/`number` index signature — assignable in spirit,
    // since every one of our level names is one of Pino's, but not structurally to our closed `EmitLevel`
    // record without a cast.
    return this.#pino.levels as unknown as LevelMapping
  }

  isLevelEnabled(level: string): boolean {
    return this.#pino.isLevelEnabled(level)
  }

  bindings(): Bindings {
    return this.#pino.bindings()
  }

  child(bindings: Bindings, options?: ChildOptions): Logger {
    // `options.customLevels` is typed as a plain index signature here (`ChildOptions` is reimplemented without
    // importing Pino's types), so Pino infers its own `CustomLevels` type parameter as `string` rather than
    // `never` and widens the return type. The instance itself is unaffected — only the generic label is.
    return new PinoLogger(this.#pino.child(bindings, options) as unknown as PinoInstance)
  }

  flush(cb?: (err?: Error) => void): void {
    this.#pino.flush(cb)
  }
}

/** Whether what was handed over is an already-built Pino logger rather than the options to build one. */
function isPinoInstance(options?: LoggerOptions | PinoInstance): options is PinoInstance {
  return options !== undefined && typeof (options as PinoInstance).child === 'function'
}
