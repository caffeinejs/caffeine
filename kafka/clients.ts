import { Admin, Consumer, jsonDeserializer, jsonSerializer, Producer, stringDeserializer, stringSerializer } from '@platformatic/kafka'
import type { AdminClient, ConsumerClient, ConsumerStream, KafkaClients, KafkaConsumerEvent, KafkaDeserializers, KafkaSerializers, ProducerClient, ResolvedKafkaConfig, TopicSpec } from './config.js'

/**
 * Default producer serializers: string keys, JSON values (Spring-like `KafkaTemplate<String, Object>`), and
 * string header keys/values so the retry-journey headers (`x-original-topic`, ...) encode to bytes on the wire.
 */
export const defaultSerializers: KafkaSerializers = {
  key: stringSerializer,
  value: jsonSerializer,
  headerKey: stringSerializer,
  headerValue: stringSerializer,
}

/** Default consumer deserializers: string keys, JSON values, string header keys/values (mirrors the serializers). */
export const defaultDeserializers: KafkaDeserializers = {
  key: stringDeserializer,
  value: jsonDeserializer,
  headerKey: stringDeserializer,
  headerValue: stringDeserializer,
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

  createAdmin(config: ResolvedKafkaConfig): AdminClient {
    const admin = new Admin({ clientId: config.clientId, bootstrapBrokers: config.brokers })

    return {
      async createTopics(topics: TopicSpec[]): Promise<void> {
        for (const spec of topics) {
          const request = { topics: [spec.topic], partitions: spec.partitions, replicas: spec.replicas }
          try {
            await admin.createTopics(request as never)
          } catch {
            // Topic already exists — provisioning is idempotent.
          }
        }
      },
      async partitionCounts(topics: string[]): Promise<Map<string, number>> {
        const counts = new Map<string, number>()
        if (topics.length === 0) {
          return counts
        }
        try {
          const metadata = await admin.metadata({ topics }) as { topics: Map<string, { partitionsCount: number }> }
          for (const [topic, info] of metadata.topics) {
            counts.set(topic, info.partitionsCount)
          }
        } catch {
          // Metadata unavailable (e.g. a source topic does not exist yet) — inheritance falls back to the default.
        }
        return counts
      },
      async deleteTopics(topics: string[]): Promise<void> {
        await admin.deleteTopics({ topics } as never)
      },
      close(): Promise<void> {
        return admin.close()
      },
    }
  },
}
