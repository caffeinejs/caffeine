import { Consumer, jsonDeserializer, jsonSerializer, Producer, stringDeserializer, stringSerializer } from '@platformatic/kafka'
import type { ConsumerClient, ConsumerStream, KafkaClients, KafkaConsumerEvent, KafkaDeserializers, KafkaSerializers, ProducerClient, ResolvedKafkaConfig } from './config.js'

/** Default producer serializers: string keys, JSON values (Spring-like `KafkaTemplate<String, Object>`). */
export const defaultSerializers: KafkaSerializers = {
  key: stringSerializer,
  value: jsonSerializer,
}

/** Default consumer deserializers: string keys, JSON values. */
export const defaultDeserializers: KafkaDeserializers = {
  key: stringDeserializer,
  value: jsonDeserializer,
}

// Normalized lifecycle event → the platformatic event name it maps to.
const EVENT_MAP: Record<KafkaConsumerEvent, string> = {
  join: 'consumer:group:join',
  leave: 'consumer:group:leave',
  rebalance: 'consumer:group:rebalance',
  connect: 'client:broker:connect',
  disconnect: 'client:broker:disconnect',
  lag: 'consumer:lag',
}

interface Emitter {
  on(event: string, listener: (payload: unknown) => void): unknown
}

/**
 * The production client factory. Builds real `@platformatic/kafka` clients. The narrow casts adapt the
 * vendor's fully-generic `Producer`/`Consumer` to the integration's string-key/JSON-value surface — the one
 * place the vendor generics are pinned.
 */
export const defaultKafkaClients: KafkaClients = {
  createProducer(config: ResolvedKafkaConfig): ProducerClient {
    return new Producer({
      clientId: config.clientId,
      bootstrapBrokers: config.brokers,
      serializers: config.serializers as never,
    }) as unknown as ProducerClient
  },

  createConsumer(config: ResolvedKafkaConfig, groupId: string): ConsumerClient {
    const consumer = new Consumer({
      groupId,
      clientId: config.clientId,
      bootstrapBrokers: config.brokers,
      deserializers: config.deserializers as never,
    })

    return {
      async consume(options): Promise<ConsumerStream> {
        const consumeOptions: Record<string, unknown> = { topics: options.topics, autocommit: options.autocommit }
        if (options.deserializers !== undefined) {
          consumeOptions.deserializers = options.deserializers
        }
        return await consumer.consume(consumeOptions as never) as unknown as ConsumerStream
      },
      close(force?: boolean): Promise<void> {
        return consumer.close(force)
      },
      on(event: KafkaConsumerEvent, listener): void {
        ;(consumer as unknown as Emitter).on(EVENT_MAP[event], payload => listener({ groupId, detail: payload }))
      },
    }
  },
}
