import type { ConsumerBinding, ProducerBinding } from './binding.js'
import type { Message } from './message.js'

/**
 * The broker I/O primitives for one consumed record, supplied by the binder to the core dispatch loop. The
 * binder owns *how* each is performed on the wire (Kafka offset commit, AMQP ack/nack, NATS ack policy); the
 * core owns *when* (via the resolved {@link RetryStrategy}). This is the seam that keeps broker mechanics in the
 * binder while retry orchestration stays portable.
 */
export interface DeliveryControl {
  /** The destination this record originated on (from provenance headers, or the consumed destination). */
  readonly source: string
  /** The 1-based attempt this delivery represents (from retry headers, or 1 on the main destination). */
  readonly attempt: number
  /** Blocks until the record's not-before time (no-op when absent or already past). */
  sleepUntilReady(): Promise<void>
  /** Publishes this record to `destination`, stamping the journey headers. */
  forward(destination: string, headers?: Record<string, string>): Promise<void>
  /** Commits after a successful handler run, honouring the binder's ack mode. */
  commitSuccess(): Promise<void>
  /** Advances past this record after forwarding/recovery, honouring the binder's ack mode. */
  commitAdvance(): Promise<void>
}

/** The core dispatch entrypoint a binder calls for every consumed message. */
export type Dispatch = (message: Message, control: DeliveryControl) => Promise<void>

/** A live consumer opened by a binder; the messaging runtime stops it on shutdown. */
export interface BoundConsumer {
  stop(): Promise<void>
}

/** A live producer opened by a binder for one outbound binding. */
export interface BoundProducer {
  send(message: Message): Promise<void>
}

/**
 * The SPI one messaging technology implements. One `Binder` is one named instance (`name`); a binding's `via`
 * selects it. The messaging core calls this and never branches on the binder kind — anything that cannot be
 * expressed without core knowing the technology belongs in the binder package.
 */
export interface Binder {
  /** The binder instance name a binding's `via` targets (not the technology kind). */
  readonly name: string
  /** Opens one consumer for an inbound binding, routing every message through `dispatch`. */
  startConsumer(binding: ConsumerBinding, dispatch: Dispatch): Promise<BoundConsumer>
  /** Opens one producer for an outbound binding. */
  bindProducer(binding: ProducerBinding): Promise<BoundProducer>
  /** Closes every consumer and producer this binder opened and disconnects its clients. */
  stop(): Promise<void>
}
