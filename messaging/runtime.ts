import type { Container } from '@caffeinejs/di'
import type { SchemaIssue } from '@caffeinejs/std/schema'
import type { Binder } from './binder.js'
import type { ConsumerBinding, ProducerBinding } from './binding.js'
import type { RecoverContext } from './error_handling.js'
import type { Message } from './message.js'

/** Invoked when an inbound message fails its binding's schema — instead of the handler. */
export type InvalidMessageHandler = (issues: SchemaIssue[], message: Message, binding: string) => void

/** Fire-and-forget observation of a message the pipeline gave up on (logging/metrics); does not decide recovery. */
export type ErrorObserver = (error: unknown, message: Message, ctx: RecoverContext) => void

/** Terminal handler invoked after retries are exhausted (or a non-retryable error). Portable dead-letter lives here. */
export type Recoverer = (error: unknown, message: Message, ctx: RecoverContext) => void | Promise<void>

/**
 * The internal per-application messaging seam threaded into the engine and the bus. Holds the registered binder
 * instances (keyed by name) and the resolved inbound/outbound bindings (keyed by binding name). One runtime per
 * `messaging()` integration; unlike Kafka's per-instance runtime, the engine coordinates every binder.
 */
export interface MessagingRuntime {
  container: Container
  binders: Map<string, Binder>
  inbound: Map<string, ConsumerBinding>
  outbound: Map<string, ProducerBinding>
  /** Optional hook fired when an inbound message fails schema validation; unset = skip + advance (logged). */
  onInvalidMessage?: InvalidMessageHandler
  /** Optional observation hook fired when the pipeline gives up on a message (before the recoverer). */
  onError?: ErrorObserver
  /** Optional terminal recoverer invoked once retries are exhausted (or a non-retryable error). */
  recoverer?: Recoverer
}
