import type { ConsumerClient, ConsumerStream, KafkaMessage } from './config.js'
import { kSignals } from './symbols.js'
import type { KafkaTemplate, SendOptions } from './template.js'

/** Engine-facing per-dispatch state, read by the listener container to drive commit/retry. */
export interface ContextSignals {
  acked: boolean
  nacked: boolean
  nackDelay?: number
  attempt: number
}

/** Construction input for a {@link KafkaContext}. */
export interface KafkaContextInit {
  message: KafkaMessage
  groupId: string
  instance: string
  consumer: ConsumerClient
  stream: ConsumerStream
  template: KafkaTemplate
  /** The topic this record originated on (differs from `message.topic` on retry topics). */
  sourceTopic?: string
  /** The 1-based attempt this delivery starts at (from the retry headers, or 1 on the main topic). */
  attempt?: number
}

/**
 * Per-message operations handed to a `@KafkaListener` via the `$k.context()` picker — the Kafka counterpart of
 * the HTTP `FastifyContext`. Exposes the record's metadata, manual acknowledgement (`ack`/`nack`), and
 * producing (`send`). One instance per delivery; reused across retry attempts (its `attempt` advances).
 */
export class KafkaContext<Value = unknown> {
  readonly #message: KafkaMessage<Value>
  readonly #groupId: string
  readonly #instance: string
  readonly #consumer: ConsumerClient
  readonly #stream: ConsumerStream
  readonly #template: KafkaTemplate
  readonly #sourceTopic: string

  /** Engine-facing signal bag; not part of the documented surface (symbol-keyed). */
  readonly [kSignals]: ContextSignals = { acked: false, nacked: false, attempt: 1 }

  constructor(init: KafkaContextInit) {
    this.#message = init.message as KafkaMessage<Value>
    this.#groupId = init.groupId
    this.#instance = init.instance
    this.#consumer = init.consumer
    this.#stream = init.stream
    this.#template = init.template
    this.#sourceTopic = init.sourceTopic ?? init.message.topic
    this[kSignals].attempt = init.attempt ?? 1
  }

  /** The whole consumed record (headers, topic, key, value, partition, offset, commit). */
  get message(): KafkaMessage<Value> {
    return this.#message
  }

  get topic(): string {
    return this.#message.topic
  }

  /** The topic this record originated on. Equals {@link topic} on the main topic; the source on retry topics. */
  get sourceTopic(): string {
    return this.#sourceTopic
  }

  get partition(): number {
    return this.#message.partition
  }

  get offset(): bigint {
    return this.#message.offset
  }

  get key(): string {
    return this.#message.key
  }

  get value(): Value {
    return this.#message.value
  }

  get headers(): Map<string, string> {
    return this.#message.headers
  }

  get timestamp(): bigint {
    return this.#message.timestamp
  }

  /** The consumer group id serving this message. */
  get groupId(): string {
    return this.#groupId
  }

  /** The kafka instance name serving this message. */
  get instance(): string {
    return this.#instance
  }

  /** The 1-based delivery attempt (increments on each retry). */
  get attempt(): number {
    return this[kSignals].attempt
  }

  /** Escape hatch: the underlying consumer. */
  get consumer(): ConsumerClient {
    return this.#consumer
  }

  /** Escape hatch: the underlying message stream. */
  get stream(): ConsumerStream {
    return this.#stream
  }

  /** Commits this message's offset. Meaningful in `manual` ack mode. */
  async ack(): Promise<void> {
    this[kSignals].acked = true
    await this.#message.commit()
  }

  /** Alias of {@link ack}. */
  commit(): Promise<void> {
    return this.ack()
  }

  /** Requests in-process re-delivery of this message, optionally after a delay (ms). */
  nack(delayMs?: number): void {
    this[kSignals].nacked = true
    this[kSignals].nackDelay = delayMs
  }

  /** Produces a message through this instance's `KafkaTemplate`. */
  send<T = unknown>(topic: string, value: T, options?: SendOptions): Promise<void> {
    return this.#template.send(topic, value, options)
  }
}
