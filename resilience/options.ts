import { type Duration, formatDuration } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { described, type ErrorClass, ErrInvalidOption } from './errors.js'
import { type Clock, systemClock } from './timers.js'

/**
 * Checks one factory's options, value by value, so every factory words a bad one the same way:
 * `Cannot create retry "inventory": maxAttempts must be an integer of at least 1, got 0`. A method of a live instance
 * checks its arguments the same way, under its own action, such as `change`.
 */
export class Options {
  readonly name: string
  readonly #kind: string
  readonly #action: 'create' | 'change' | 'open'

  /** @throws {@link ErrInvalidOption} when `options` carries no non-empty `name`. */
  constructor(
    kind: string,
    options: { readonly name?: unknown } | undefined,
    action: 'create' | 'change' | 'open' = 'create',
  ) {
    const name = options?.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new ErrInvalidOption(
        errMessage(`Cannot create ${kind}: name must be a non-empty string`)
          .reference('@caffeinejs/resilience', ErrInvalidOption)
          .build(),
      )
    }

    this.#kind = kind
    this.#action = action
    this.name = name
  }

  invalid(reason: string, ...solutions: string[]): ErrInvalidOption {
    return new ErrInvalidOption(
      errMessage(`Cannot ${this.#action} ${this.#kind} "${this.name}": ${reason}`)
        .solutions(...solutions)
        .reference('@caffeinejs/resilience', ErrInvalidOption)
        .build(),
    )
  }

  integer(key: string, value: number, min: number, ...solutions: string[]): number {
    if (!Number.isInteger(value) || value < min) {
      throw this.invalid(`${key} must be an integer of at least ${min}, got ${String(value)}`, ...solutions)
    }
    return value
  }

  /** An integer from `min` to `max`, both included. */
  integerIn(key: string, value: number, min: number, max: number): number {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw this.invalid(`${key} must be an integer from ${min} to ${max}, got ${String(value)}`)
    }
    return value
  }

  /** A finite span of at least `min`. */
  duration(key: string, value: Duration, min: Duration): Duration {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
      throw this.invalid(
        `${key} must be a finite Duration of at least ${formatDuration(min)}, got ${formatDuration(value)}`,
      )
    }
    return value
  }

  /** A finite span above zero, such as a limit nothing could meet at zero. */
  positiveDuration(key: string, value: Duration, ...solutions: string[]): Duration {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw this.invalid(`${key} must be a finite Duration greater than 0s, got ${formatDuration(value)}`, ...solutions)
    }
    return value
  }

  percent(key: string, value: number): number {
    if (typeof value !== 'number' || !(value > 0 && value <= 100)) {
      throw this.invalid(`${key} must be greater than 0 and at most 100, got ${String(value)}`)
    }
    return value
  }

  boolean(key: string, value: boolean | undefined, fallback: boolean): boolean {
    const resolved = value ?? fallback
    if (typeof resolved !== 'boolean') {
      throw this.invalid(`${key} must be a boolean, got ${typeof resolved}`)
    }
    return resolved
  }

  function<F>(key: string, value: F | undefined): F | undefined {
    if (value !== undefined && typeof value !== 'function') {
      throw this.invalid(`${key} must be a function, got ${typeof value}`)
    }
    return value
  }

  /**
   * An `ErrorMatcher` as a predicate; a list of classes is checked here, once. A predicate may take more than the
   * error, as `retryOn` takes the attempt.
   */
  matcher<P extends (error: unknown, ...rest: never[]) => boolean = (error: unknown) => boolean>(
    key: string,
    value: P | readonly ErrorClass[] | undefined,
  ): P | ((error: unknown) => boolean) | undefined {
    if (value === undefined || typeof value === 'function') {
      return value
    }
    if (!Array.isArray(value) || !value.every(entry => typeof entry === 'function')) {
      throw this.invalid(`${key} must be a function or an array of error classes, got ${described(value)}`)
    }

    const classes: readonly ErrorClass[] = [...value]
    return (error: unknown) => {
      for (const cls of classes) {
        if (error instanceof cls) {
          return true
        }
      }
      return false
    }
  }

  clock(value: Clock | undefined): Clock {
    if (value === undefined) {
      return systemClock
    }
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof value.now !== 'function' ||
      typeof value.setTimeout !== 'function' ||
      typeof value.clearTimeout !== 'function'
    ) {
      throw this.invalid('clock must be an object with now(), setTimeout() and clearTimeout() methods')
    }
    return value
  }
}
