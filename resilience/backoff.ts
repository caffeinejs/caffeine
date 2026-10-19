import { type Duration, formatDuration, Millisecond, Second } from '@caffeinejs/std/duration'
import { errMessage } from '@caffeinejs/std/err'

import { ErrInvalidOption } from './errors.js'

/** Maps a 1-based attempt number to a delay. */
export type Backoff = (attempt: number) => Duration

export interface ExponentialOptions {
  /** Delay before the second attempt. Defaults to 500 milliseconds. */
  initialDelay?: Duration
  /** Growth per attempt. Defaults to 2. */
  multiplier?: number
  /** Upper bound of every delay. Defaults to 30 seconds. */
  maxDelay?: Duration
  /**
   * Randomization factor in `[0, 1)`: a delay `d` becomes a value in `[d·(1−jitter), d·(1+jitter)]`, cut at
   * `maxDelay`. A delay that reached the cap is spread over `[maxDelay·(1−jitter), maxDelay]`. Defaults to 0.
   */
  jitter?: number
}

function invalid(reason: string): ErrInvalidOption {
  return new ErrInvalidOption(
    errMessage(`Cannot create exponential backoff: ${reason}`)
      .reference('@caffeinejs/resilience', ErrInvalidOption)
      .build(),
  )
}

/**
 * A delay of `initialDelay · multiplier^(attempt−1)`, capped at `maxDelay`, then randomized by `jitter` without
 * passing the cap.
 *
 * @throws {@link ErrInvalidOption} when an option is out of range.
 */
export function exponential(options: ExponentialOptions = {}): Backoff {
  const { initialDelay = 500 * Millisecond, multiplier = 2, maxDelay = 30 * Second, jitter = 0 } = options

  if (!Number.isFinite(initialDelay) || initialDelay < 0) {
    throw invalid(`initialDelay must be a finite Duration of at least 0s, got ${formatDuration(initialDelay)}`)
  }

  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw invalid(`multiplier must be a finite number of at least 1, got ${multiplier}`)
  }

  if (typeof maxDelay !== 'number' || Number.isNaN(maxDelay) || maxDelay < 0) {
    throw invalid(`maxDelay must be a Duration of at least 0s, got ${formatDuration(maxDelay)}`)
  }

  if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) {
    throw invalid(`jitter must be at least 0 and less than 1, got ${jitter}`)
  }

  // Nothing multiplied stays nothing, and `0 · multiplier^n` is NaN once the power overflows.
  if (initialDelay === 0) {
    return () => 0
  }

  return attempt => {
    const raw = initialDelay * multiplier ** (attempt - 1)
    const base = raw < maxDelay ? raw : maxDelay
    if (jitter === 0) {
      return base
    }

    // The band is cut at the cap instead of collapsing onto it, so capped delays still differ between clients.
    const low = base * (1 - jitter)
    const high = base * (1 + jitter)
    const top = high < maxDelay ? high : maxDelay
    const delay = low + Math.random() * (top - low)
    return delay < top ? delay : top
  }
}
