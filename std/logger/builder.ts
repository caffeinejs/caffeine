import { type FeatureConfigureKit, kFeatureName } from '../feature.js'
import { FeatureBuilder } from '../feature_builder.js'
import { ConsoleLogger } from './console/console.js'
import { ErrLoggerAlreadyConfigured } from './errors.js'
import { logToken } from './keys.js'
import type { Logger } from './logger.js'
import { noopLogger } from './noop.js'

/**
 * Configures the application's logger.
 *
 * A `Feature`, unlike the eager `ApplicationOptions.logger` path: `.use()`/`.disable()` run once configuration
 * resolves — `.logger((b, { config }) => b.disable(config.app.logEnabled))` reads a real value, not a schema
 * default.
 */
export class LoggerBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'logger'

  #logger: Logger | undefined
  #disabled = false
  #level: string | undefined

  // Separate from `#logger`: caches the fallback so repeated reads of `.logger` agree on one instance, without
  // making `.use()` think a real logger was already provided — `#logger` stays `undefined` until `.use()`
  // itself sets it.
  #defaultLogger: Logger | undefined

  /**
   * Provides the logger to use.
   *
   * A web application's server is built with whatever logger was available when it was constructed, so a logger
   * provided here does not reach it — `ApplicationOptions.logger` does, and so does {@link level}.
   *
   * @throws {@link ErrLoggerAlreadyConfigured} When a logger was already provided.
   */
  use(logger: Logger): this {
    if (this.#logger !== undefined) {
      throw new ErrLoggerAlreadyConfigured()
    }

    this.#logger = logger

    return this
  }

  /** Disables the logger — every write goes to a `NoopLogger` — or, called with `false`, re-enables it. */
  disable(flag: boolean = true): this {
    this.#disabled = flag

    return this
  }

  /**
   * Sets the level on whatever logger this resolves to, when the feature configures.
   *
   * The level is handed to the logger's own setter, so it decides what it accepts: `ConsoleLogger` and
   * `PinoLogger` take the seven `LOG_LEVELS`, and `ConsoleLogger` refuses anything else.
   *
   * @throws ErrInvalidLogLevel From `ready()`, when the logger refuses the level.
   */
  level(level: string): this {
    this.#level = level

    return this
  }

  /**
   * What was provided, a bare `ConsoleLogger` if nothing was, or the `NoopLogger` if disabled.
   *
   * The fallback `ConsoleLogger` is built once and cached, not once per read — `Application` reads this more
   * than once (its own `#logger` field, and again inside `configure()`'s binding), and each read must agree
   * on the same instance.
   */
  get logger(): Logger {
    return this.#disabled ? noopLogger : (this.#logger ?? (this.#defaultLogger ??= new ConsoleLogger()))
  }

  protected configure(kit: FeatureConfigureKit<C>): void {
    const logger = this.logger

    // Never while disabled: `noopLogger` is one shared instance, so a level written to it would follow every
    // other application in the process.
    if (this.#level !== undefined && !this.#disabled) {
      logger.level = this.#level
    }

    kit.container.rebind(logToken(), t => t.toValue(logger))
  }
}
