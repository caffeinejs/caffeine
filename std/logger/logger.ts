/** The severity levels every {@link Logger} understands, in ascending order of importance. */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent'

/** The levels a mapping or a `LogFn` set actually emits at — `silent` is a threshold, not one of them. */
export type EmitLevel = Exclude<LogLevel, 'silent'>

/** Fields a child logger merges into every record it writes. */
export type Bindings = Record<string, unknown>

/** A field's value transform before it is written — Pino's own `SerializerFn` shape, reimplemented here. */
export type SerializerFn = (value: unknown) => unknown

/** Pino's own `redactOptions` shape, reimplemented here so the contract needs no import from `pino`. */
export interface RedactOptions {
  paths: string[]
  censor?: string | ((value: unknown, path: string[]) => unknown)
  remove?: boolean
}

/**
 * What a child logger may override at the moment it is derived — the same shape as Pino's own
 * `ChildLoggerOptions`, reimplemented here so the contract needs no import from `pino`.
 */
export interface ChildOptions<TLevel extends string = string> {
  level?: string
  serializers?: Record<string, SerializerFn>
  customLevels?: Record<TLevel, number>
  formatters?: {
    level?: (label: string, number: number) => object
    bindings?: (bindings: Bindings) => object
    log?: (object: object) => object
  }
  redact?: string[] | RedactOptions
  msgPrefix?: string
}

/**
 * One severity's call signature, data first.
 *
 * An object in the first position carries the structured fields and the message follows it; a string in the
 * first position is the message. Trailing arguments format the message the way `util.format` does.
 *
 * ```ts
 * log.error({ err }, 'cannot load order %s', orderID)
 * ```
 */
export interface LogFn {
  <T extends object>(obj: T, msg?: string, ...args: unknown[]): void
  (obj: unknown, msg?: string, ...args: unknown[]): void
  (msg: string, ...args: unknown[]): void
}

/** A level's name-to-number and number-to-name mapping — Pino's own `LevelMapping` shape. */
export interface LevelMapping<TLevel extends string = EmitLevel> {
  values: Record<TLevel, number>
  labels: Record<number, TLevel>
}

/**
 * The logging contract, independent of whatever library writes the records.
 *
 * The shape is Pino's, so a `pino.Logger` satisfies it as it stands and an implementation of it is accepted
 * wherever Fastify asks for a `FastifyBaseLogger` — `Fastify({ loggerInstance: log })`.
 *
 * `level` is a plain string rather than {@link LogLevel} because an implementation may define levels of its
 * own; {@link LOG_LEVELS} names the seven every implementation here supports. `TLevel` and `TBindings` type
 * {@link levels} and {@link bindings} for an implementation that knows more specifically what it carries.
 */
export interface Logger<TLevel extends string = EmitLevel, TBindings extends Bindings = Bindings> {
  level: string
  /** The levels this instance understands, by name and by number. */
  readonly levels: LevelMapping<TLevel>
  trace: LogFn
  debug: LogFn
  info: LogFn
  warn: LogFn
  error: LogFn
  fatal: LogFn
  /** Writes nothing, whatever the level. Present so a severity can be silenced by name. */
  silent: LogFn
  /** Whether a record at `level` would be written, given the current level. */
  isLevelEnabled(level: string): boolean
  /** The fields merged into every record this instance writes. */
  bindings(): TBindings
  /** Derives a logger that merges `bindings` into every record it writes. */
  child(bindings: Bindings, options?: ChildOptions<TLevel>): Logger<TLevel, TBindings>
  /** Writes out whatever the implementation has buffered. A synchronous implementation does nothing. */
  flush(cb?: (err?: Error) => void): void
}

/** The numeric severity of each {@link LogLevel}, matching Pino's. */
export const LOG_LEVELS: Readonly<Record<LogLevel, number>> = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
})

/** Whether `level` names one of the {@link LOG_LEVELS}. */
export function isLogLevel(level: string): level is LogLevel {
  return Object.hasOwn(LOG_LEVELS, level)
}
