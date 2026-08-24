import type { Ctor } from '@caffeinejs/di'
import { HealthIndicator, kServiceConfigure, type Service, type ServiceKit } from '@caffeinejs/std'
import { defaultDeserializers, defaultSerializers } from './clients.js'
import { type DeserializationErrorHandler, type KafkaAckMode, type KafkaClients, type KafkaDeserializers, type KafkaMessage, type KafkaSerializers, resolveConfig, type TopicProvisioning } from './config.js'
import type { DeadLetterOptions, ErrorClassifier, KafkaRecoverer, RetryPolicy } from './error_handling.js'
import { ErrKafkaMissingBrokers } from './errors.js'
import { KafkaHealthIndicator } from './health.js'
import { KafkaListenerContainer } from './listener_container.js'
import type { DeadLetterManager } from './retry/dead_letter_manager.js'
import { retryTopics, type RetryStrategy, type RetryTopicOptions, sharedRetryTopic } from './retry/strategy.js'
import type { KafkaRuntime } from './runtime.js'
import { containerKey, DEFAULT_INSTANCE, kafkaTemplate, Keys, runtimeKey } from './symbols.js'
import { KafkaTemplate } from './template.js'

/**
 * Fluent configuration for one (optionally named) Kafka integration. Follows the repo feature-builder
 * convention (`app.kafka(k => k.brokers(...).groupId(...))`): it accumulates settings, then at `ready()` time
 * its `[kServiceConfigure]` binds this instance's runtime, `KafkaTemplate`, and `KafkaListenerContainer` into
 * the container under per-instance keys.
 */
export class KafkaBuilder implements Service {
  readonly #name: string
  readonly #clients: KafkaClients
  #brokers?: string | string[]
  #clientId?: string
  #groupId?: string
  #serializers?: KafkaSerializers
  #deserializers?: KafkaDeserializers
  #ackMode?: KafkaAckMode
  #retry?: RetryPolicy
  #retryStrategy?: RetryStrategy
  #topicProvisioning?: TopicProvisioning
  #deadLetterManager?: DeadLetterManager
  #deadLetter?: DeadLetterOptions | boolean
  #notRetryable?: Ctor<Error>[]
  #retryable?: Ctor<Error>[]
  #classifier?: ErrorClassifier
  #recoverer?: KafkaRecoverer
  #onDeserializationError?: DeserializationErrorHandler
  #onError?: (error: unknown, message: KafkaMessage) => void

  constructor(name: string, clients: KafkaClients) {
    this.#name = name
    this.#clients = clients
  }

  /** One or more `host:port` bootstrap brokers. Required. */
  brokers(brokers: string | string[]): this {
    this.#brokers = brokers
    return this
  }

  /** Client identifier reported to the broker. */
  clientId(clientId: string): this {
    this.#clientId = clientId
    return this
  }

  /** Default consumer group id for listeners that do not declare their own. */
  groupId(groupId: string): this {
    this.#groupId = groupId
    return this
  }

  /** Overrides the default producer serializers (`{ key: string, value: json }`). */
  serializers(serializers: KafkaSerializers): this {
    this.#serializers = serializers
    return this
  }

  /** Overrides the default consumer deserializers (`{ key: string, value: json }`). */
  deserializers(deserializers: KafkaDeserializers): this {
    this.#deserializers = deserializers
    return this
  }

  /** Commit strategy: `auto` (default), `record` (commit after each success), or `manual` (`ctx.ack()`). */
  ackMode(mode: KafkaAckMode): this {
    this.#ackMode = mode
    return this
  }

  /** Instance-default retry policy for failing handlers (blocking, in-process retry). */
  retry(policy: RetryPolicy): this {
    this.#retry = policy
    return this
  }

  /** Sets an explicit instance-default retry strategy (blocking, retry-topics, or custom); overrides `retry`. */
  retryStrategy(strategy: RetryStrategy): this {
    this.#retryStrategy = strategy
    return this
  }

  /** Non-blocking retry via per-level topics (`${topic}-retry-N`), then dead-letter. Uber/Spring style. */
  retryTopics(policy: RetryPolicy, options?: RetryTopicOptions): this {
    this.#retryStrategy = retryTopics(policy, options)
    return this
  }

  /** Non-blocking retry via a single shared `${topic}-retry` topic (attempt/delay carried in headers). */
  sharedRetryTopic(policy: RetryPolicy, options?: RetryTopicOptions): this {
    this.#retryStrategy = sharedRetryTopic(policy, options)
    return this
  }

  /** Configures auto-creation of the retry/dead-letter topics (partitions/replicas, or opt-out). */
  topicProvisioning(options: TopicProvisioning): this {
    this.#topicProvisioning = options
    return this
  }

  /** Overrides the built-in dead-letter manager (inspect/purge/re-inject) for this instance. */
  deadLetterManager(manager: DeadLetterManager): this {
    this.#deadLetterManager = manager
    return this
  }

  /** Enables dead-letter recovery (default `${topic}.DLT`) once retries are exhausted. */
  deadLetter(options: DeadLetterOptions | boolean = true): this {
    this.#deadLetter = options
    return this
  }

  /** Exceptions that must never be retried. */
  notRetryable(...errors: Ctor<Error>[]): this {
    this.#notRetryable = [...(this.#notRetryable ?? []), ...errors]
    return this
  }

  /** If set, only these exceptions are retried. */
  retryable(...errors: Ctor<Error>[]): this {
    this.#retryable = [...(this.#retryable ?? []), ...errors]
    return this
  }

  /** Full control over retry classification; wins over `notRetryable`/`retryable`. */
  classifier(classifier: ErrorClassifier): this {
    this.#classifier = classifier
    return this
  }

  /** Terminal recoverer after retries are exhausted; overrides the built-in dead-letter recoverer. */
  recoverer(recoverer: KafkaRecoverer): this {
    this.#recoverer = recoverer
    return this
  }

  /** Handles records that fail deserialization (routed here instead of the listener). */
  onDeserializationError(handler: DeserializationErrorHandler): this {
    this.#onDeserializationError = handler
    return this
  }

  /** Observation hook invoked when the pipeline gives up on a message (logging/metrics). */
  onError(onError: (error: unknown, message: KafkaMessage) => void): this {
    this.#onError = onError
    return this
  }

  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    if (this.#brokers === undefined) {
      return Promise.reject(new ErrKafkaMissingBrokers())
    }

    const config = resolveConfig(
      {
        brokers: this.#brokers,
        clientId: this.#clientId,
        groupId: this.#groupId,
        serializers: this.#serializers,
        deserializers: this.#deserializers,
        ackMode: this.#ackMode,
        retry: this.#retry,
        retryStrategy: this.#retryStrategy,
        topicProvisioning: this.#topicProvisioning,
        deadLetterManager: this.#deadLetterManager,
        deadLetter: this.#deadLetter,
        notRetryable: this.#notRetryable,
        retryable: this.#retryable,
        classifier: this.#classifier,
        recoverer: this.#recoverer,
        onDeserializationError: this.#onDeserializationError,
        onError: this.#onError,
      },
      { serializers: defaultSerializers, deserializers: defaultDeserializers },
    )
    if (config.brokers.length === 0 || config.brokers.some(broker => broker.length === 0)) {
      return Promise.reject(new ErrKafkaMissingBrokers())
    }

    const runtime: KafkaRuntime = { name: this.#name, container: kit.container, config, clients: this.#clients }
    const rKey = runtimeKey(this.#name)
    const tKey = kafkaTemplate(this.#name)

    kit.container.bind(rKey).toValue(runtime)

    // The default instance's template is bound under the KafkaTemplate class (so it can be injected by type),
    // carrying tKey as a name alias. Named instances bind under their name key only.
    if (this.#name === DEFAULT_INSTANCE) {
      kit.container.bind(KafkaTemplate).toClass(KafkaTemplate, [rKey]).names(tKey)
    } else {
      kit.container.bind(tKey).toClass(KafkaTemplate, [rKey])
    }

    kit.container
      .bind(containerKey(this.#name))
      .toClass(KafkaListenerContainer, [rKey, tKey])
      .labels(Keys.KAFKA_CONTAINER)

    // Registered once, covering every configured instance. Inert unless the application exposes the probes, and
    // then it is what makes readiness mean "serving HTTP *and* consuming" rather than "the port is open".
    if (!kit.container.has(KafkaHealthIndicator)) {
      const container = kit.container
      kit.container
        .bind(KafkaHealthIndicator)
        .toFactory(() => new KafkaHealthIndicator(container))
        .extends(HealthIndicator)
    }

    return Promise.resolve()
  }
}
