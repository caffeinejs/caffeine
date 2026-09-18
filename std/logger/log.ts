import { type AbstractCtor } from '@caffeinejs/di'

import { ConsoleLogger } from './console/console.js'
import type { Bindings, ChildOptions, Logger } from './logger.js'

/**
 * A static, instance-free entry point to logging — for code with no `Application` to inject from, `std`'s own
 * internals most of all. Independent of any `Application`: `.use()` sets one process-wide logger, `.for()`
 * derives named children from it.
 *
 * ```ts
 * Log.use(newPinoLogger({ level: 'debug' }))   // the first thing a process does
 * const log = Log.for(CatalogService)          // child logger, { name: 'CatalogService' }
 * ```
 */
export class Log {
  static #logger: Logger = new ConsoleLogger()

  /** Sets the process-wide logger every `.for(...)` child derives from. Call this once, before anything logs. */
  static use(logger: Logger): void {
    Log.#logger = logger
  }

  /**
   * A child of the global logger, named `name` — a string, or a class reference whose own `.name` is read.
   * Otherwise the same shape as {@link Logger.child}: `bindings` and `options` pass straight through.
   *
   * @param bindings - Additional fields merged in; a `name` there overrides the derived one.
   */
  static for(name: string | AbstractCtor, bindings?: Bindings, options?: ChildOptions): Logger {
    const label = typeof name === 'string' ? name : name.name

    return Log.#logger.child({ name: label, ...bindings }, options)
  }

  private constructor() {
    /* Class is static-only */
  }
}
