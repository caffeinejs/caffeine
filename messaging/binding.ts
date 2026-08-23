import type { Ctor } from '@caffeinejs/di'
import type { AnySchema } from '@caffeinejs/std'
import type { ErrorClassifier, RetryPolicy } from './error_handling.js'

/** The direction of a binding: inbound (consume) or outbound (produce). */
export type BindingDirection = 'in' | 'out'

/**
 * A resolved inbound binding: everything a binder needs to open one consumer. `binding` is the logical name
 * handlers attach to; `destination` is the physical broker name; `group` is the competing-consumer identity;
 * `options` carries binder-native tuning (Kafka ack mode/deserializers, AMQP routing key) — **opaque to the
 * messaging core**, typed by the binder package. Core validates `via` + wiring only, never `options`.
 */
export interface ConsumerBinding {
  binding: string
  destination: string
  via: string
  group?: string
  contentType?: string
  schema?: AnySchema
  /** Portable blocking-retry policy for a failing handler; defaults to a single attempt (no retry). */
  retry?: RetryPolicy
  /** Error types that must never be retried (go straight to the recoverer). */
  notRetryable?: Ctor<Error>[]
  /** If set, only these error types are retried (everything else recovers immediately). */
  retryable?: Ctor<Error>[]
  /** Full control over retry classification; wins over `notRetryable`/`retryable`. */
  classifier?: ErrorClassifier
  options?: Record<string, unknown>
}

/** A resolved outbound binding: everything a binder needs to open one producer. */
export interface ProducerBinding {
  binding: string
  destination: string
  via: string
  contentType?: string
  schema?: AnySchema
  options?: Record<string, unknown>
}
