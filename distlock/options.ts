/** The settings a lock service runs on, resolved and normalized to milliseconds. */
export interface DistLockOptions {
  /** How long a lease is good for when a call does not say. */
  ttlMs: number

  /** How long `acquire` spends retrying when a call does not say. */
  waitMs: number

  /** The pause between two attempts, before jitter. */
  retryDelayMs: number

  /**
   * The fraction of `retryDelayMs` added at random to each pause, between `0` and `1`.
   *
   * A lock is where retries synchronize: every waiter woke up because the same holder released, so without
   * jitter they all attempt again on the same tick.
   */
  retryJitter: number
}

export const DEFAULT_DIST_LOCK_OPTIONS: DistLockOptions = {
  ttlMs: 30_000,
  waitMs: 5_000,
  retryDelayMs: 100,
  retryJitter: 0.5,
}
