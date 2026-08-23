import type { KafkaMessage } from '../config.js'
import { delayFor, type RetryPolicy, sleep } from '../error_handling.js'
import { ErrKafkaNackExhausted } from '../errors.js'
import { RetryHeaders } from '../symbols.js'

/**
 * A retry destination a {@link RetryStrategy} consumes from beyond the main topic: one delay tier. The engine
 * opens an isolated consumer for `topic` and auto-provisions it (with `partitions`, if given). `delay` is the
 * block-and-sleep floor a record waits before the retry consumer invokes the handler.
 */
export interface RetryTopic {
  topic: string
  delay: number
  partitions?: number
}

/**
 * One record's journey through a retry strategy, handed to {@link RetryStrategy.dispatch}. The listener
 * container implements it, closing over the route, message, ack mode, and template; a strategy only orchestrates
 * the primitives (invoke → classify → forward/recover → commit) without touching the engine internals.
 */
export interface RetryDelivery {
  /** The consumed record (its topic may be a retry topic; `sourceTopic` is the origin). */
  readonly message: KafkaMessage
  /** The topic this record originated on (from the `x-original-topic` header, or `message.topic`). */
  readonly sourceTopic: string
  /** The 1-based attempt this delivery represents (from `x-retry-attempt`, or 1 on the main topic). */
  readonly initialAttempt: number
  /** Whether the handler called `ctx.ack()` during the last {@link invoke}. */
  readonly acked: boolean
  /** Whether the handler called `ctx.nack()` during the last {@link invoke}. */
  readonly nacked: boolean
  /** The delay (ms) the handler requested via `ctx.nack(delay)`, if any. */
  readonly nackDelay?: number
  /** Resets the per-attempt signal state and sets the current 1-based attempt (drives `ctx.attempt`). */
  reset(attempt: number): void
  /** Runs the handler once (request-scoped when applicable). Throws whatever the handler throws. */
  invoke(): Promise<void>
  /** Classifies a thrown error: `true` = retry, `false` = terminal (recover). */
  classify(error: unknown, attempt: number): boolean
  /** Blocks until the record's `x-retry-not-before` time (no-op when absent or already past). */
  sleepUntilReady(): Promise<void>
  /** Publishes this record to `topic` (a retry or dead-letter topic), stamping the journey headers. */
  forward(topic: string, headers?: Record<string, string>): Promise<void>
  /** Terminal path: fires the `onError` observation hook and the resolved recoverer. Does not commit. */
  recover(error: unknown): Promise<void>
  /** Commits after a successful handler run, honouring the ack mode (`record` commits; `auto`/`manual` do not). */
  commitSuccess(): Promise<void>
  /** Advances past this record after forwarding/recovery, honouring the ack mode (`auto` leaves it to autocommit). */
  commitAdvance(): Promise<void>
}

/**
 * The retry SPI the listener container delegates every dispatch to. A strategy declares the extra topics it needs
 * consumed + provisioned ({@link topics}, {@link deadLetterTopic}) and drives one delivery ({@link dispatch}).
 * Ship-with builtins: {@link blockingRetry} (in-process, the default), {@link retryTopics} (per-level
 * non-blocking, Spring `@RetryableTopic` / Uber reliable-reprocessing), and {@link sharedRetryTopic}.
 */
export interface RetryStrategy {
  /** Extra retry topics (delay tiers) to consume + auto-create for a source topic. Blocking returns `[]`. */
  topics(source: string): RetryTopic[]
  /** The dead-letter topic for a source topic, if this strategy uses one (drives provisioning). */
  deadLetterTopic?(source: string): string | undefined
  /** Drives one record through the strategy. */
  dispatch(delivery: RetryDelivery): Promise<void>
}

/** Tuning for the topic-forwarding strategies ({@link retryTopics}, {@link sharedRetryTopic}). */
export interface RetryTopicOptions {
  /** Names a retry topic for a source topic and 0-based level. Default `${source}-retry-${level}`. */
  topicNamer?: (source: string, level: number) => string
  /** Names the dead-letter topic for a source topic. Default `${source}.DLT`. */
  deadLetterNamer?: (source: string) => string
  /** Partition count for auto-created retry topics. */
  partitions?: number
}

/**
 * In-process blocking retry: re-invokes the handler up to `attempts` times with backoff, stalling only the
 * current partition (other partitions of the same consumer keep flowing). On exhaustion — or a non-retryable
 * error — it recovers (dead-letter/custom). This is v3's behaviour and the default when `.retry(policy)` is set.
 */
export function blockingRetry(policy: RetryPolicy): RetryStrategy {
  const attempts = Math.max(1, policy.attempts)

  return {
    topics: () => [],
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
          await delivery.recover(new ErrKafkaNackExhausted(delivery.sourceTopic, attempt))
          await delivery.commitAdvance()
          return
        }

        await delivery.commitSuccess()
        return
      }
    },
  }
}

/**
 * Non-blocking per-level retry topics (Spring `@RetryableTopic` / the pattern Uber documented as reliable
 * reprocessing). A failing record is published to the next `${source}-retry-N` topic — each an isolated consumer
 * with its own escalating delay tier — and the source offset advances immediately, so live traffic never blocks.
 * Exhausting the last tier (or a non-retryable error) dead-letters the record.
 */
export function retryTopics(policy: RetryPolicy, options: RetryTopicOptions = {}): RetryStrategy {
  const attempts = Math.max(1, policy.attempts)
  const namer = options.topicNamer ?? ((source, level) => `${source}-retry-${level}`)
  const dltNamer = options.deadLetterNamer ?? (source => `${source}.DLT`)

  return {
    topics(source: string): RetryTopic[] {
      const list: RetryTopic[] = []
      for (let level = 0; level < attempts - 1; level++) {
        const delay = delayFor(policy.backoff, level + 1)
        list.push({ topic: namer(source, level), delay, partitions: options.partitions })
      }
      return list
    },
    deadLetterTopic: (source: string) => dltNamer(source),
    dispatch: forwardingDispatch(policy, attempts, (source, attempt) => namer(source, attempt - 1)),
  }
}

/**
 * Non-blocking retry through a single shared `${source}-retry` topic: the attempt count and delay ride in the
 * record's headers instead of one-topic-per-tier. Fewer topics to manage, but records of different delay tiers
 * share one partition, so a long tier can head-of-line-block shorter ones. Exhaustion dead-letters the record.
 */
export function sharedRetryTopic(policy: RetryPolicy, options: RetryTopicOptions = {}): RetryStrategy {
  const attempts = Math.max(1, policy.attempts)
  const namer = options.topicNamer ?? (source => `${source}-retry`)
  const dltNamer = options.deadLetterNamer ?? (source => `${source}.DLT`)

  return {
    topics: (source: string) =>
      (attempts > 1 ? [{ topic: namer(source, 0), delay: 0, partitions: options.partitions }] : []),
    deadLetterTopic: (source: string) => dltNamer(source),
    dispatch: forwardingDispatch(policy, attempts, source => namer(source, 0)),
  }
}

// Shared dispatch for the forwarding strategies: honour the not-before delay, invoke once, then forward to the
// next retry topic (retryable and budget remaining) or recover (non-retryable or exhausted). `nextTopic` maps a
// source topic + current attempt to the destination.
function forwardingDispatch(
  policy: RetryPolicy,
  attempts: number,
  nextTopic: (source: string, attempt: number) => string,
): (delivery: RetryDelivery) => Promise<void> {
  return async (delivery: RetryDelivery): Promise<void> => {
    await delivery.sleepUntilReady()

    const attempt = delivery.initialAttempt
    delivery.reset(attempt)

    let failure: unknown
    try {
      await delivery.invoke()
      if (!delivery.nacked) {
        await delivery.commitSuccess()
        return
      }
      failure = new ErrKafkaNackExhausted(delivery.sourceTopic, attempt)
    } catch (error) {
      if (!delivery.classify(error, attempt)) {
        await delivery.recover(error)
        await delivery.commitAdvance()
        return
      }
      failure = error
    }

    if (attempt < attempts) {
      const delay = delivery.nackDelay ?? delayFor(policy.backoff, attempt)
      const err = failure instanceof Error ? failure : new Error(String(failure))
      await delivery.forward(nextTopic(delivery.sourceTopic, attempt), {
        [RetryHeaders.ATTEMPT]: String(attempt + 1),
        [RetryHeaders.NOT_BEFORE]: String(Date.now() + delay),
        'x-exception-class': err.name,
        'x-exception-message': err.message,
      })
      await delivery.commitAdvance()
      return
    }

    await delivery.recover(failure)
    await delivery.commitAdvance()
  }
}
