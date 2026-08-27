import type { KafkaOutboundMessage, ProducerClient } from './config.js'
import type { KafkaRuntime } from './runtime.js'

/** Options accepted by {@link KafkaTemplate.send}. */
export interface SendOptions {
  /** Message key (used for partitioning). */
  key?: string
  /** Message headers. */
  headers?: Record<string, string>
  /** Explicit partition; omit to let the broker/partitioner decide. */
  partition?: number
}

/**
 * A thin producer wrapper. The underlying platformatic `Producer` is created lazily on first send, so
 * constructing the template (which happens eagerly at container init) never opens a broker connection.
 */
export class KafkaTemplate {
  readonly #runtime: KafkaRuntime
  #producer?: ProducerClient

  constructor(runtime: KafkaRuntime) {
    this.#runtime = runtime
  }

  /** The lazily-created underlying producer. Exposed for advanced use (transactions, batching, ...). */
  producer(): ProducerClient {
    this.#producer ??= this.#runtime.clients.createProducer(this.#runtime.config)
    return this.#producer
  }

  /** Sends a single value to a topic. */
  async send<Value = unknown>(topic: string, value: Value, options: SendOptions = {}): Promise<void> {
    await this.producer().send({
      messages: [{ topic, value, key: options.key, headers: options.headers, partition: options.partition }],
    })
  }

  /** Sends a fully-formed message. */
  async sendMessage<Value = unknown>(message: KafkaOutboundMessage<Value>): Promise<void> {
    await this.producer().send({ messages: [message] })
  }

  /** Sends a batch of messages in a single request. */
  async sendBatch(messages: KafkaOutboundMessage[]): Promise<void> {
    if (messages.length === 0) {
      return
    }
    await this.producer().send({ messages })
  }

  /** Closes the underlying producer if one was created. */
  async close(): Promise<void> {
    if (this.#producer !== undefined) {
      const producer = this.#producer
      this.#producer = undefined
      await producer.close()
    }
  }
}
