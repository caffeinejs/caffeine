import type { Ctor } from '@caffeinejs/di'
import type { KafkaMessage } from './config.js'
import type { KafkaTemplate } from './template.js'

/** Backoff strategy between retry attempts. */
export type BackOff
  = | { type: 'fixed', delay: number }
    | { type: 'exponential', delay: number, multiplier?: number, max?: number }

/** A retry policy: `attempts` is the total number of tries (at least 1); `backoff` spaces them out. */
export interface RetryPolicy {
  attempts: number
  backoff?: BackOff
}

/** The delay (ms) to wait before the attempt following `attempt` (1-based). */
export function delayFor(backoff: BackOff | undefined, attempt: number): number {
  if (backoff === undefined) {
    return 0
  }
  if (backoff.type === 'fixed') {
    return backoff.delay
  }
  const multiplier = backoff.multiplier ?? 2
  const raw = backoff.delay * multiplier ** (attempt - 1)
  return backoff.max !== undefined ? Math.min(raw, backoff.max) : raw
}

/** Resolves after `ms` (immediately for non-positive values). */
export function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve()
  }
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Decides whether a thrown error is worth retrying. `true` = retry, `false` = go straight to the recoverer. */
export type ErrorClassifier = (error: unknown, attempt: number) => boolean

/** Declarative classification config; `classifier` (if given) wins over the allow/deny lists. */
export interface ClassifierConfig {
  notRetryable?: Ctor<Error>[]
  retryable?: Ctor<Error>[]
  classifier?: ErrorClassifier
}

/** Builds a classifier: retry everything except `notRetryable`; if `retryable` is set, retry only those. */
export function buildClassifier(config: ClassifierConfig): ErrorClassifier {
  if (config.classifier !== undefined) {
    return config.classifier
  }
  const notRetryable = config.notRetryable ?? []
  const retryable = config.retryable

  return (error: unknown): boolean => {
    if (notRetryable.some(type => error instanceof type)) {
      return false
    }
    if (retryable !== undefined && retryable.length > 0) {
      return retryable.some(type => error instanceof type)
    }
    return true
  }
}

/** Context handed to a recoverer when retries are exhausted (or the error is not retryable). */
export interface RecoverContext {
  attempt: number
  groupId: string
  instance: string
}

/** Terminal handler invoked after all retries fail. Publishes to a dead-letter topic, logs, stores, etc. */
export type KafkaRecoverer = (record: KafkaMessage, error: unknown, ctx: RecoverContext) => void | Promise<void>

/** Options for the built-in dead-letter recoverer. */
export interface DeadLetterOptions {
  /** Target topic; defaults to `${record.topic}.DLT`. */
  topic?: (record: KafkaMessage) => string
  /** Extra headers to add, merged over the default exception headers. */
  headers?: (record: KafkaMessage, error: unknown) => Record<string, string>
}

/**
 * A recoverer that republishes the failed record to a dead-letter topic (default `${topic}.DLT`) via the
 * instance's {@link KafkaTemplate}, stamping exception + provenance headers. Mirrors Spring's
 * `DeadLetterPublishingRecoverer`.
 */
export function deadLetterRecoverer(template: KafkaTemplate, options: DeadLetterOptions = {}): KafkaRecoverer {
  return async (record, error, ctx) => {
    const topic = options.topic?.(record) ?? `${record.topic}.DLT`
    const err = error instanceof Error ? error : new Error(String(error))

    const headers: Record<string, string> = {
      'x-exception-class': err.name,
      'x-exception-message': err.message,
      'x-original-topic': record.topic,
      'x-original-partition': String(record.partition),
      'x-original-offset': String(record.offset),
      'x-attempts': String(ctx.attempt),
      ...(err.stack !== undefined ? { 'x-exception-stacktrace': err.stack } : {}),
      ...(options.headers?.(record, error) ?? {}),
    }

    await template.sendMessage({ topic, key: record.key, value: record.value, headers })
  }
}
