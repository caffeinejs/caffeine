import type { Ctor } from '@caffeinejs/di'
import type { Deserializers, Message, MessageToProduce, Serializers } from '@platformatic/kafka'
import type { DeadLetterOptions, ErrorClassifier, KafkaRecoverer, RetryPolicy } from './error_handling.js'
import type { DeadLetterManager } from './retry/dead_letter_manager.js'
import type { RetryStrategy } from './retry/strategy.js'

/** A consumed record handed to a `@KafkaListener` method. Alias of the platformatic `Message`. */
export type KafkaMessage<Value = unknown> = Message<string, Value, string, string>

/** Commit strategy. `auto` = platformatic autocommit; `record` = commit after each success; `manual` = ctx.ack(). */
export type KafkaAckMode = 'auto' | 'record' | 'manual'

/** The raw record handed to a deserialization-error handler (the value never deserialized). */
export interface DeserializationErrorRecord {
  topic: string
  partition: number
  offset: bigint
  rawValue?: Buffer
  headers?: Map<string, string>
}

/** Handles a record whose key/value could not be deserialized. Runs instead of the listener. */
export type DeserializationErrorHandler = (error: unknown, record: DeserializationErrorRecord) => void | Promise<void>

/** Controls auto-creation of the retry/dead-letter topics a non-blocking retry strategy declares. */
export interface TopicProvisioning {
  /** Create declared retry/DLT topics via the `Admin` client at startup. Default `true`. */
  autoCreate?: boolean
  /** Partition count for auto-created topics (a strategy's per-topic value wins). Default `1`. */
  partitions?: number
  /** Replication factor for auto-created topics. Default `1`. */
  replicas?: number
}

/** A record accepted by the producer/template. */
export type KafkaOutboundMessage<Value = unknown> = MessageToProduce<string, Value, string, string>

/** Serializers used by the producer. String key, arbitrary value (JSON by default). */
export type KafkaSerializers = Partial<Serializers<string, unknown, string, string>>

/** Deserializers used by consumers. String key, arbitrary value (JSON by default). */
export type KafkaDeserializers = Partial<Deserializers<string, unknown, string, string>>

/**
 * User-facing Kafka configuration, supplied through the plugin (`kafka({ ... })`) or, later, application
 * config. `brokers` is the only required field.
 */
export interface KafkaConfig {
  /** One or more `host:port` bootstrap brokers. */
  brokers: string | string[]
  /** Client identifier reported to the broker. Defaults to `caffeine-kafka`. */
  clientId?: string
  /** Default consumer group id, used by listeners that do not declare their own. */
  groupId?: string
  /** Overrides the default producer serializers (`{ key: string, value: json }`). */
  serializers?: KafkaSerializers
  /** Overrides the default consumer deserializers (`{ key: string, value: json }`). */
  deserializers?: KafkaDeserializers
  /** Commit strategy; defaults to `auto` (platformatic autocommit). */
  ackMode?: KafkaAckMode
  /** Instance-default retry policy for failing handlers (blocking retry). Overridable per listener. */
  retry?: RetryPolicy
  /** Instance-default retry strategy; overrides `retry`. Use `retryTopics`/`sharedRetryTopic` for non-blocking. */
  retryStrategy?: RetryStrategy
  /** Auto-creation of the retry/dead-letter topics a non-blocking strategy declares. */
  topicProvisioning?: TopicProvisioning
  /** Overrides the built-in dead-letter manager (inspect/purge/re-inject) for this instance. */
  deadLetterManager?: DeadLetterManager
  /** Enables dead-letter recovery (default `${topic}.DLT`). `true` uses defaults; an object customizes it. */
  deadLetter?: DeadLetterOptions | boolean
  /** Exceptions that must never be retried (go straight to the recoverer). */
  notRetryable?: Ctor<Error>[]
  /** If set, only these exceptions are retried (everything else recovers immediately). */
  retryable?: Ctor<Error>[]
  /** Full control over retry classification; wins over `notRetryable`/`retryable`. */
  classifier?: ErrorClassifier
  /** Terminal recoverer invoked after retries are exhausted. Overrides the built-in dead-letter recoverer. */
  recoverer?: KafkaRecoverer
  /** Handles records that fail deserialization (routed here instead of the listener). */
  onDeserializationError?: DeserializationErrorHandler
  /**
   * Observation hook invoked when the pipeline finally gives up on a message (after retries, before/around
   * recovery). Fire-and-forget — logging/metrics only; retry/skip/dead-letter decisions come from the config
   * above.
   */
  onError?: (error: unknown, message: KafkaMessage) => void
}

/** Normalized configuration the runtime works with — brokers as an array, defaults filled in. */
export interface ResolvedKafkaConfig {
  brokers: string[]
  clientId: string
  groupId?: string
  serializers: KafkaSerializers
  deserializers: KafkaDeserializers
  ackMode: KafkaAckMode
  retry?: RetryPolicy
  retryStrategy?: RetryStrategy
  // `partitions` stays optional: unset means "inherit the source topic's partition count" at provisioning time.
  topicProvisioning: { autoCreate: boolean, partitions?: number, replicas: number }
  deadLetterManager?: DeadLetterManager
  deadLetter?: DeadLetterOptions | boolean
  notRetryable?: Ctor<Error>[]
  retryable?: Ctor<Error>[]
  classifier?: ErrorClassifier
  recoverer?: KafkaRecoverer
  onDeserializationError?: DeserializationErrorHandler
  onError?: (error: unknown, message: KafkaMessage) => void
}

/** The producer surface the integration depends on (a narrow view of the platformatic `Producer`). */
export interface ProducerClient {
  send(options: { messages: KafkaOutboundMessage[], acks?: number }): Promise<unknown>
  close(force?: boolean): Promise<void>
}

/** A consumed-message stream: async-iterable with an explicit `close` (matches platformatic `MessagesStream`). */
export interface ConsumerStream extends AsyncIterable<KafkaMessage> {
  close(): Promise<void>
}

/** The consumer surface the integration depends on (a narrow view of the platformatic `Consumer`). */
export interface ConsumerClient {
  consume(options: {
    topics: string[]
    autocommit?: boolean | number
    deserializers?: KafkaDeserializers
  }): Promise<ConsumerStream>
  close(force?: boolean): Promise<void>
  /** Subscribes to a normalized lifecycle event. Optional — fakes may omit it. */
  on?(event: KafkaConsumerEvent, listener: (payload: KafkaConsumerEventPayload) => void): void
}

/** Normalized consumer lifecycle events surfaced by {@link KafkaListenerContainer}. */
export type KafkaConsumerEvent = 'join' | 'leave' | 'rebalance' | 'connect' | 'disconnect' | 'lag'

/** Payload carried by a normalized consumer lifecycle event. */
export interface KafkaConsumerEventPayload {
  groupId: string
  [key: string]: unknown
}

/** A topic to create, for {@link AdminClient.createTopics}. */
export interface TopicSpec {
  topic: string
  partitions: number
  replicas: number
}

/** The admin surface the integration depends on (a narrow view of the platformatic `Admin`). */
export interface AdminClient {
  /** Creates topics, ignoring any that already exist. */
  createTopics(topics: TopicSpec[]): Promise<void>
  /** Returns the partition count of each named topic that exists (absent when the topic is unknown). Optional. */
  partitionCounts?(topics: string[]): Promise<Map<string, number>>
  /** Deletes topics (used by the dead-letter manager's `purge`). */
  deleteTopics(topics: string[]): Promise<void>
  close(): Promise<void>
}

/**
 * The client factory seam. The default implementation builds real platformatic clients; tests pass a fake
 * to drive the integration without a broker.
 */
export interface KafkaClients {
  createProducer(config: ResolvedKafkaConfig): ProducerClient
  createConsumer(config: ResolvedKafkaConfig, groupId: string): ConsumerClient
  /** Creates an admin client for topic provisioning. Optional — fakes/minimal setups may omit it. */
  createAdmin?(config: ResolvedKafkaConfig): AdminClient
}

/** Normalizes user config: brokers to an array, a default client id, and default (string/JSON) serializers. */
export function resolveConfig(config: KafkaConfig, defaults: {
  serializers: KafkaSerializers
  deserializers: KafkaDeserializers
}): ResolvedKafkaConfig {
  const brokers = Array.isArray(config.brokers) ? config.brokers : [config.brokers]

  return {
    brokers,
    clientId: config.clientId ?? 'caffeine-kafka',
    groupId: config.groupId,
    serializers: { ...defaults.serializers, ...config.serializers },
    deserializers: { ...defaults.deserializers, ...config.deserializers },
    ackMode: config.ackMode ?? 'auto',
    retry: config.retry,
    retryStrategy: config.retryStrategy,
    topicProvisioning: {
      autoCreate: config.topicProvisioning?.autoCreate ?? true,
      // Left undefined when the user did not set it, so provisioning inherits the source topic's partition count.
      partitions: config.topicProvisioning?.partitions,
      replicas: config.topicProvisioning?.replicas ?? 1,
    },
    deadLetterManager: config.deadLetterManager,
    deadLetter: config.deadLetter,
    notRetryable: config.notRetryable,
    retryable: config.retryable,
    classifier: config.classifier,
    recoverer: config.recoverer,
    onDeserializationError: config.onDeserializationError,
    onError: config.onError,
  }
}
