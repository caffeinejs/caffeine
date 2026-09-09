import type {
  Binder,
  BinderFactory,
  BoundConsumer,
  BoundProducer,
  ConsumerBinding,
  DeliveryControl,
  Dispatch,
  Message,
  ProducerBinding,
} from '@caffeinejs/messaging'
import { sleep } from '@caffeinejs/messaging'

import { defaultDeserializers, defaultKafkaClients, defaultSerializers } from './clients.js'
import {
  type ConsumerClient,
  type ConsumerStream,
  type KafkaAckMode,
  type KafkaClients,
  type KafkaDeserializers,
  type KafkaMessage,
  type KafkaSerializers,
  type ProducerClient,
  resolveConfig,
  type ResolvedKafkaConfig,
} from './config.js'
import { extractDeserError, wrapDeserializers } from './deser.js'
import { ErrKafkaMissingBrokers, ErrKafkaMissingGroupID } from './errors.js'
import { RetryHeaders } from './symbols.js'

/** Options for {@link kafkaBinder}. `clients` is the test seam (a `FakeBroker`); the rest mirror `KafkaConfig`. */
export interface KafkaBinderOptions {
  brokers: string | string[]
  clientId?: string
  groupId?: string
  serializers?: KafkaSerializers
  deserializers?: KafkaDeserializers
  ackMode?: KafkaAckMode
  /** Overrides the platformatic client factory (tests inject a fake broker). */
  clients?: KafkaClients
  /**
   * Observation hook for an infrastructure error while pumping a record (a failing commit, a throwing recoverer,
   * a stream fault) — never a handler error, which the engine's retry/recover owns. The pump keeps running; this
   * is where you log/alert. Unset = swallow and continue.
   */
  onError?: (error: unknown) => void
}

/**
 * A `@caffeinejs/messaging` {@link Binder} backed by Kafka — the additive "Fork Y" wrap. It reuses the existing
 * {@link KafkaClients} seam but is a separate, thinner consume path from `KafkaListenerContainer`; the direct
 * `.extend(kafka(), …)` API is untouched. Register it on the messaging builder:
 *
 * ```ts
 * .extend(messaging(), m => m
 *   .use('kafka', kafkaBinder({ brokers: 'localhost:9092', groupId: 'svc' }))
 *   .in('orders', { destination: 'orders', via: 'kafka' }))
 * ```
 *
 * Retry is the portable `blockingRetry` driven by the messaging engine; Kafka-native non-blocking retry topics
 * and dead-letter recovery stay on the `.extend(kafka(), …)` path.
 */
export function kafkaBinder(options: KafkaBinderOptions): BinderFactory {
  if (options.brokers === undefined || options.brokers.length === 0) {
    throw new ErrKafkaMissingBrokers()
  }

  const clients = options.clients ?? defaultKafkaClients
  const config = resolveConfig(
    {
      brokers: options.brokers,
      clientId: options.clientId,
      groupId: options.groupId,
      serializers: options.serializers,
      deserializers: options.deserializers,
      ackMode: options.ackMode,
    },
    { serializers: defaultSerializers, deserializers: defaultDeserializers },
  )

  return (name: string): Binder => new KafkaBinder(name, config, clients, options.onError)
}

class KafkaBinder implements Binder {
  readonly name: string
  readonly #config: ResolvedKafkaConfig
  readonly #clients: KafkaClients
  readonly #onError?: (error: unknown) => void
  readonly #consumers: Array<{ stream: ConsumerStream; consumer: ConsumerClient }> = []
  #producer?: ProducerClient
  #stopped = false

  constructor(name: string, config: ResolvedKafkaConfig, clients: KafkaClients, onError?: (error: unknown) => void) {
    this.name = name
    this.#config = config
    this.#clients = clients
    this.#onError = onError
  }

  startConsumer(binding: ConsumerBinding, dispatch: Dispatch): Promise<BoundConsumer> {
    const group = binding.group ?? this.#config.groupId
    if (group === undefined || group.length === 0) {
      throw new ErrKafkaMissingGroupID(binding.binding)
    }

    const ackMode = this.#config.ackMode
    const consumer = this.#clients.createConsumer(this.#config, group)

    const bound = (async (): Promise<BoundConsumer> => {
      const stream = await consumer.consume({
        topics: [binding.destination],
        autocommit: ackMode === 'auto',
        deserializers: wrapDeserializers(this.#config.deserializers),
      })
      this.#consumers.push({ stream, consumer })

      // Detached pump: the messaging engine owns retry/commit decisions via the DeliveryControl below.
      void this.#pump(stream, binding, dispatch, ackMode)

      return {
        stop: async (): Promise<void> => {
          this.#stopped = true
          await stream.close()
          await consumer.close()
        },
      }
    })()

    return bound
  }

  bindProducer(binding: ProducerBinding): Promise<BoundProducer> {
    const producer = this.#ensureProducer()
    return Promise.resolve({
      send: (message: Message): Promise<void> => {
        const record = { topic: binding.destination, value: message.payload, headers: toKafkaHeaders(message.headers) }
        return producer.send({ messages: [record] }).then(() => undefined)
      },
    })
  }

  async stop(): Promise<void> {
    this.#stopped = true
    for (const { stream, consumer } of this.#consumers.splice(0)) {
      await stream.close()
      await consumer.close()
    }
    if (this.#producer !== undefined) {
      await this.#producer.close()
      this.#producer = undefined
    }
  }

  async #pump(
    stream: ConsumerStream,
    binding: ConsumerBinding,
    dispatch: Dispatch,
    ackMode: KafkaAckMode,
  ): Promise<void> {
    try {
      for await (const msg of stream) {
        try {
          const deserError = extractDeserError(msg)
          if (deserError !== undefined) {
            // Poison record: never invoke the handler; advance past it so it does not block the partition.
            if (ackMode !== 'auto') {
              void msg.commit()
            }
            continue
          }

          const message: Message = {
            payload: msg.value,
            headers: (msg.headers ?? new Map()) as Message['headers'],
            ...(binding.contentType !== undefined ? { contentType: binding.contentType } : {}),
          }
          const control = new KafkaDeliveryControl(msg, this.#ensureProducer(), ackMode, binding.destination)
          await dispatch(message, control)
        } catch (error) {
          // Infrastructure error dispatching ONE record (failed commit, throwing recoverer). Never kill the
          // whole consumer over a single record — report and move on to the next one.
          if (this.#stopped) {
            return
          }
          this.#onError?.(error)
        }
      }
    } catch (error) {
      // A genuine stream fault (or a normal close during shutdown). Surface real faults; stay quiet on shutdown.
      if (!this.#stopped) {
        this.#onError?.(error)
      }
    }
  }

  #ensureProducer(): ProducerClient {
    this.#producer ??= this.#clients.createProducer(this.#config)
    return this.#producer
  }
}

// Kafka's default header serializer is string-based; stringify any binary header values a portable Message carries.
function toKafkaHeaders(headers: Message['headers']): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of headers) {
    out.set(key, typeof value === 'string' ? value : value.toString())
  }
  return out
}

/** Maps the messaging {@link DeliveryControl} primitives onto one consumed {@link KafkaMessage}. */
class KafkaDeliveryControl implements DeliveryControl {
  readonly source: string
  readonly attempt: number

  readonly #message: KafkaMessage
  readonly #producer: ProducerClient
  readonly #ackMode: KafkaAckMode

  constructor(message: KafkaMessage, producer: ProducerClient, ackMode: KafkaAckMode, destination: string) {
    this.#message = message
    this.#producer = producer
    this.#ackMode = ackMode
    this.source = message.headers?.get(RetryHeaders.ORIGINAL_TOPIC) ?? message.topic ?? destination
    const attempt = Number(message.headers?.get(RetryHeaders.ATTEMPT))
    this.attempt = Number.isFinite(attempt) && attempt > 0 ? attempt : 1
  }

  async sleepUntilReady(): Promise<void> {
    const notBefore = Number(this.#message.headers?.get(RetryHeaders.NOT_BEFORE))
    if (Number.isFinite(notBefore) && notBefore > Date.now()) {
      await sleep(notBefore - Date.now())
    }
  }

  forward(destination: string, headers?: Record<string, string>): Promise<void> {
    // Carry the record's own headers forward, overlay the journey headers, and stamp the origin topic when a
    // prior hop has not — so the next hop's KafkaDeliveryControl reads the right source/attempt.
    const merged = new Map<string, string>(this.#message.headers ?? [])
    for (const [key, value] of Object.entries(headers ?? {})) {
      merged.set(key, value)
    }
    if (!merged.has(RetryHeaders.ORIGINAL_TOPIC)) {
      merged.set(RetryHeaders.ORIGINAL_TOPIC, this.source)
    }
    const record = { topic: destination, key: this.#message.key, value: this.#message.value, headers: merged }
    return this.#producer.send({ messages: [record] }).then(() => undefined)
  }

  commitSuccess(): Promise<void> {
    return this.#commit()
  }

  commitAdvance(): Promise<void> {
    return this.#commit()
  }

  #commit(): Promise<void> {
    // `auto` leaves commits to platformatic autocommit; otherwise advance the offset past this record.
    if (this.#ackMode !== 'auto') {
      void this.#message.commit()
    }
    return Promise.resolve()
  }
}
