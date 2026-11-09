import type { Backoff } from '@caffeinejs/resilience'
import { type Duration, Millisecond, Second } from '@caffeinejs/std/duration'

/** The settings a lock service runs on, resolved. */
export interface DistLockOptions {
  /** How long a lease is good for when a call does not say. */
  ttl: Duration

  /** How long `acquire` spends retrying when a call does not say. */
  wait: Duration

  /**
   * The pause after the first attempt, before jitter. Each later pause doubles it, up to `maxRetryDelay`. Also the
   * longest pause before a failed renewal is tried again, which `backoff` does not change.
   */
  retryDelay: Duration

  /** The longest pause between two attempts, before jitter. */
  maxRetryDelay: Duration

  /**
   * How far each pause is spread at random, in `[0, 1)`: a pause `d` lands in `[d·(1−j), d·(1+j)]`, cut at
   * `maxRetryDelay`.
   *
   * A lock is where retries synchronize: every waiter woke up because the same holder released, so without
   * jitter they all attempt again on the same tick.
   */
  retryJitter: number

  /**
   * The pause after each attempt, by attempt number from 1. Replaces `retryDelay`, `maxRetryDelay` and
   * `retryJitter` when set. Code only: a configuration tree cannot carry a function.
   */
  backoff?: Backoff

  /**
   * How long one backend call may take before the caller stops waiting for it.
   *
   * An acquisition waits at most `min(storeTimeout, ttl)` and an extension at most what is left of the lease, so
   * an answer that could only carry a lease already gone is never waited for. A lease that arrives after the
   * caller gave up is released with its own token.
   */
  storeTimeout: Duration
}

// The longest delay `setTimeout` honours. Node turns anything larger into 1 ms, which would time every backend call
// out at once.
export const MAX_TIMER_DELAY: Duration = 2 ** 31 - 1

export const DEFAULT_DIST_LOCK_OPTIONS: DistLockOptions = {
  ttl: 30 * Second,
  wait: 5 * Second,
  retryDelay: 50 * Millisecond,
  maxRetryDelay: 1 * Second,
  retryJitter: 0.5,
  storeTimeout: 5 * Second,
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
  maxRetryDelay?: Duration
  retryJitter?: number
  storeTimeout?: Duration
}
