import { delayFor, type RetryPolicy, sleep } from './error_handling.js'
import { ErrNackExhausted } from './errors.js'
import type { Message } from './message.js'

/**
 * A retry destination a {@link RetryStrategy} consumes from beyond the main destination: one delay tier. The
 * binder opens an isolated consumer for `destination` and auto-provisions it. `delay` is the block-and-sleep
 * floor a record waits before the retry consumer invokes the handler. `options` carries binder-native tuning
 * (e.g. Kafka partition count) — opaque to the messaging core.
 */
export interface RetryDestination {
  destination: string
  delay: number
  options?: Record<string, unknown>
}

/**
 * One record's journey through a retry strategy, handed to {@link RetryStrategy.dispatch}. The binder's dispatch
 * engine implements it, closing over the route, message, ack mode, and producer; a strategy only orchestrates the
 * primitives (invoke → classify → forward/recover → commit) without touching the binder internals.
 */
export interface RetryDelivery {
  /** The consumed message (its destination may be a retry destination; `source` is the origin). */
  readonly message: Message
  /** The destination this record originated on (from provenance headers, or the consumed destination). */
  readonly source: string
  /** The 1-based attempt this delivery represents (from the retry headers, or 1 on the main destination). */
  readonly initialAttempt: number
  /** Whether the handler acknowledged during the last {@link invoke}. */
  readonly acked: boolean
  /** Whether the handler called nack during the last {@link invoke}. */
  readonly nacked: boolean
  /** The delay (ms) the handler requested via nack, if any. */
  readonly nackDelay?: number
  /** Resets the per-attempt signal state and sets the current 1-based attempt. */
  reset(attempt: number): void
  /** Runs the handler once (request-scoped when applicable). Throws whatever the handler throws. */
  invoke(): Promise<void>
  /** Classifies a thrown error: `true` = retry, `false` = terminal (recover). */
  classify(error: unknown, attempt: number): boolean
  /** Blocks until the record's not-before time (no-op when absent or already past). */
  sleepUntilReady(): Promise<void>
  /** Publishes this record to `destination` (a retry or dead-letter destination), stamping journey headers. */
  forward(destination: string, headers?: Record<string, string>): Promise<void>
  /** Terminal path: fires the `onError` observation hook and the resolved recoverer. Does not commit. */
  recover(error: unknown): Promise<void>
  /** Commits after a successful handler run, honouring the ack mode. */
  commitSuccess(): Promise<void>
  /** Advances past this record after forwarding/recovery, honouring the ack mode. */
  commitAdvance(): Promise<void>
}

/**
 * The retry SPI the binder's dispatch engine delegates every dispatch to. A strategy declares the extra
 * destinations it needs consumed + provisioned ({@link destinations}, {@link deadLetterDestination}) and drives
 * one delivery ({@link dispatch}). The core ships {@link blockingRetry} (in-process, the default); non-blocking
 * strategies that forward to retry destinations are broker-specific and live in the binder package.
 */
export interface RetryStrategy {
  /** Extra retry destinations (delay tiers) to consume + auto-create for a source. Blocking returns `[]`. */
  destinations(source: string): RetryDestination[]
  /** The dead-letter destination for a source, if this strategy uses one (drives provisioning). */
  deadLetterDestination?(source: string): string | undefined
  /** Drives one record through the strategy. */
  dispatch(delivery: RetryDelivery): Promise<void>
}

/**
 * In-process blocking retry: re-invokes the handler up to `attempts` times with backoff, stalling only the
 * current partition/subscription. On exhaustion — or a non-retryable error — it recovers (dead-letter/custom).
 * This is the portable default when `.retry(policy)` is set. Touches only {@link RetryDelivery} primitives, so it
 * works unchanged across every binder.
 */
export function blockingRetry(policy: RetryPolicy): RetryStrategy {
  const attempts = Math.max(1, policy.attempts)

  return {
    destinations: () => [],
    async dispatch(delivery: RetryDelivery): Promise<void> {
      for (let attempt = 1; ; attempt++) {
        delivery.reset(attempt)

        try {
          await delivery.invoke()
        } catch (error) {
          if (delivery.classify(error, attempt) && attempt < attempts) {
            await sleep(delayFor(policy.backoff, attempt))
            continue
          }
          await delivery.recover(error)
          await delivery.commitAdvance()
          return
        }

        if (delivery.nacked) {
          if (attempt < attempts) {
            await sleep(delivery.nackDelay ?? delayFor(policy.backoff, attempt))
            continue
          }
          await delivery.recover(new ErrNackExhausted(delivery.source, attempt))
          await delivery.commitAdvance()
          return
        }

        await delivery.commitSuccess()
        return
      }
    },
  }
}
