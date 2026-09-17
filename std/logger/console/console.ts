import { format } from 'node:util'

import { ErrInvalidLogLevel } from '../errors.js'
import {
  LOG_LEVELS,
  isLogLevel,
  type Bindings,
  type ChildOptions,
  type LevelMapping,
  type LogFn,
  type LogLevel,
  type Logger,
} from '../logger.js'

/** The console method each level writes through. */
const CONSOLE_METHODS: Readonly<Record<Exclude<LogLevel, 'silent'>, 'debug' | 'info' | 'warn' | 'error'>> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'error',
}

/** `silent` aside, the levels a `ConsoleLogger` can actually be told to write at. */
const LEVELS: LevelMapping = {
  values: { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 },
  labels: { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' },
}

export interface ConsoleLoggerOptions {
  /** One of the `LOG_LEVELS`. Anything else throws {@link ErrInvalidLogLevel}. @defaultValue `'info'` */
  level?: string
  /** Fields merged into every record. */
  bindings?: Bindings
}

/**
 * A {@link Logger} that writes through `console`.
 *
 * Records are written as a timestamped line plus, when there is anything to carry, the merged fields as a
 * second argument — so a terminal keeps them inspectable instead of flattening them to a string.
 *
 * @throws {@link ErrInvalidLogLevel} When a level outside the `LOG_LEVELS` is set.
 */
export class ConsoleLogger implements Logger {
  readonly levels: LevelMapping = LEVELS

  readonly trace: LogFn
  readonly debug: LogFn
  readonly info: LogFn
  readonly warn: LogFn
  readonly error: LogFn
  readonly fatal: LogFn
  readonly silent: LogFn = () => {
    // Writes nothing, whatever the level.
  }

  readonly #bindings: Bindings

  #level: LogLevel = 'info'
  #threshold: number = LOG_LEVELS.info

  constructor(options: ConsoleLoggerOptions = {}) {
    this.#bindings = { ...options.bindings }
    this.level = options.level ?? 'info'
    this.trace = this.#writer('trace')
    this.debug = this.#writer('debug')
    this.info = this.#writer('info')
    this.warn = this.#writer('warn')
    this.error = this.#writer('error')
    this.fatal = this.#writer('fatal')
  }

  get level(): string {
    return this.#level
  }

  set level(level: string) {
    if (!isLogLevel(level)) {
      throw new ErrInvalidLogLevel(level)
    }

    this.#level = level
    this.#threshold = LOG_LEVELS[level]
  }

  isLevelEnabled(level: string): boolean {
    return isLogLevel(level) && LOG_LEVELS[level] >= this.#threshold
  }

  bindings(): Bindings {
    return { ...this.#bindings }
  }

  child(bindings: Bindings, options?: ChildOptions): Logger {
    return new ConsoleLogger({
      // An empty level means the caller named none, so the parent's is inherited: Fastify derives its
      // per-request child with the route's `logLevel`, which is `''` unless the route set one.
      level: options?.level || this.#level,
      bindings: { ...this.#bindings, ...bindings },
    })
  }

  /** Does nothing: `console` has already written by the time a call returns. */
  flush(): void {
    // Nothing is buffered.
  }

  #writer(level: Exclude<LogLevel, 'silent'>): LogFn {
    const severity = LOG_LEVELS[level]
    const label = level.toUpperCase()
    const method = CONSOLE_METHODS[level]

    return (first: unknown, ...rest: unknown[]): void => {
      if (severity < this.#threshold) {
        return
      }

      const { fields, message, args } = parse(first, rest)
      const text = args.length > 0 ? format(message, ...args) : message
      const payload = { ...this.#bindings, ...fields }
      const line = `${new Date().toISOString()} ${label} ${text}`

      if (Object.keys(payload).length > 0) {
        console[method](line, payload)
      } else {
        console[method](line)
      }
    }
  }
}

/** Splits a call into its fields, its message and the arguments that format the message. */
function parse(first: unknown, rest: unknown[]): { fields: Bindings; message: string; args: unknown[] } {
  if (typeof first === 'string') {
    return { fields: {}, message: first, args: rest }
  }

  // Anything but `undefined`/`null` is the message: Pino writes a non-string second argument rather than
  // dropping it, and losing what the caller meant to say is worse than formatting it.
  const raw = rest[0]
  const message = raw === undefined || raw === null ? undefined : String(raw)
  const args = message === undefined ? [] : rest.slice(1)

  // An error passed on its own would otherwise print as an empty object: its own enumerable properties are
  // none, and its message is the one thing the caller meant to say.
  if (first instanceof Error) {
    return { fields: { err: first }, message: message ?? first.message, args }
  }

  return {
    fields: first === null || first === undefined ? {} : (first as Bindings),
    message: message ?? '',
    args,
  }
}
