import { type Duration, Millisecond, Second } from '@caffeinejs/std/duration'

/** The settings a lock service runs on, resolved. */
export interface DistLockOptions {
  /** How long a lease is good for when a call does not say. */
  ttl: Duration

  /** How long `acquire` spends retrying when a call does not say. */
  wait: Duration

  /** The pause between two attempts, before jitter. */
  retryDelay: Duration

  /**
   * The fraction of `retryDelay` added at random to each pause, between `0` and `1`.
   *
   * A lock is where retries synchronize: every waiter woke up because the same holder released, so without
   * jitter they all attempt again on the same tick.
   */
  retryJitter: number
}

export const DEFAULT_DIST_LOCK_OPTIONS: DistLockOptions = {
  ttl: 30 * Second,
  wait: 5 * Second,
  retryDelay: 100 * Millisecond,
  retryJitter: 0.5,
}

/**
 * What `DistLockBuilder.config` accepts. In a configuration tree a duration is written as text — `'30s'`,
 * `'1m'` — and a bare number such as `'30000'` is refused; an object handed to `config(...)`
 * from code gives a `Duration`, `30 * Second`.
 *
 * The backend is not here: it is an object with methods, and stays on the builder.
 */
export interface DistLockConfig {
  ttl?: Duration
  wait?: Duration
  retryDelay?: Duration
  retryJitter?: number
}
