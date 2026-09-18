import { ErrInvalidOption } from './errors.js'

/** Maps a 1-based attempt number to a delay in milliseconds. */
export type Backoff = (attempt: number) => number

export interface ExponentialOptions {
  /** Delay before the second attempt. Defaults to 500. */
  initialDelayMs?: number
  /** Growth per attempt. Defaults to 2. */
  multiplier?: number
  /** Upper bound of every delay. Defaults to 30 000. */
  maxDelayMs?: number
  /**
   * Randomization factor in `[0, 1)`: a delay `d` becomes a value in `[d·(1−jitter), d·(1+jitter)]`, cut at
   * `maxDelayMs`. A delay that reached the cap is spread over `[maxDelayMs·(1−jitter), maxDelayMs]`. Defaults to 0.
   */
  jitter?: number
}

function invalid(reason: string): ErrInvalidOption {
  return new ErrInvalidOption(`Cannot create exponential backoff: ${reason}`)
}

/**
 * A delay of `initialDelayMs · multiplier^(attempt−1)`, capped at `maxDelayMs`, then randomized by `jitter` without
 * passing the cap.
 *
 * @throws {@link ErrInvalidOption} when an option is out of range.
 */
export function exponential(options: ExponentialOptions = {}): Backoff {
  const { initialDelayMs = 500, multiplier = 2, maxDelayMs = 30_000, jitter = 0 } = options

  if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
    throw invalid(`initialDelayMs must be a finite number of at least 0, got ${initialDelayMs}`)
  }

  if (!Number.isFinite(multiplier) || multiplier < 1) {
    throw invalid(`multiplier must be a finite number of at least 1, got ${multiplier}`)
  }

  if (typeof maxDelayMs !== 'number' || Number.isNaN(maxDelayMs) || maxDelayMs < 0) {
    throw invalid(`maxDelayMs must be a number of at least 0, got ${maxDelayMs}`)
  }

  if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) {
    throw invalid(`jitter must be at least 0 and less than 1, got ${jitter}`)
  }

  // Nothing multiplied stays nothing, and `0 · multiplier^n` is NaN once the power overflows.
  if (initialDelayMs === 0) {
    return () => 0
  }

  return attempt => {
    const raw = initialDelayMs * multiplier ** (attempt - 1)
    const base = raw < maxDelayMs ? raw : maxDelayMs
    if (jitter === 0) {
      return base
    }

    // The band is cut at the cap instead of collapsing onto it, so capped delays still differ between clients.
    const low = base * (1 - jitter)
    const high = base * (1 + jitter)
    const top = high < maxDelayMs ? high : maxDelayMs
    const delay = low + Math.random() * (top - low)
    return delay < top ? delay : top
  }
}
