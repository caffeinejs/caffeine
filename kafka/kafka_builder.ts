import type { Container, Ctor } from '@caffeinejs/di'
import {
  FeatureBuilder,
  HealthIndicator,
  kFeatureName,
  type FeatureConfigureKit,
  type FeatureConfigurer,
} from '@caffeinejs/std'

import { defaultDeserializers, defaultSerializers } from './clients.js'
import {
  type DeserializationErrorHandler,
  type KafkaAckMode,
  type KafkaClients,
  type KafkaConfigSlice,
  type KafkaDeserializers,
  type KafkaMessage,
  type ResolvedKafkaConfig,
  type KafkaSerializers,
  resolveConfig,
  type TopicProvisioning,
} from './config.js'
import type { DeadLetterOptions, ErrorClassifier, KafkaRecoverer, RetryPolicy } from './error_handling.js'
import { ErrKafkaMissingBrokers } from './errors.js'
import { KafkaHealthIndicator } from './health.js'
import { KafkaLifecycle } from './lifecycle.js'
import { KafkaListenerContainer } from './listener_container.js'
import type { DeadLetterManager } from './retry/dead_letter_manager.js'
import { retryTopics, type RetryStrategy, type RetryTopicOptions, sharedRetryTopic } from './retry/strategy.js'
import type { KafkaRuntime } from './runtime.js'
import { containerKey, DEFAULT_INSTANCE, kafkaTemplate, Keys, runtimeKey } from './symbols.js'
import { KafkaTemplate } from './template.js'

/**
 * Fluent configuration for one (optionally named) Kafka integration. Follows the repo feature-builder
 * convention (`.with(kafka(k => k.brokers(...).groupId(...)))`): it accumulates settings, then at `ready()`
 * time its `configure()` binds this instance's runtime, `KafkaTemplate`, and `KafkaListenerContainer` into
 * the container under per-instance keys. A second integration is `.with(kafka('orders', k => ...))`.
 *
 * There is one read path for everything a configuration tree can carry. Configuration overlays fluent
 * methods for `brokers`, `clientId`, `groupId`, and the rest of the configurable slice:
 * `k.brokers('localhost:9092')` is a default a deployment can redirect once {@link withConfig} is wired.
 * The members that cannot be configuration — serializers, the classifier, the recoverer, the error hooks —
 * stay on the builder and are merged in afterwards.
 */
export class KafkaBuilder<C = unknown> extends FeatureBuilder<C> {
  get [kFeatureName](): string {
    return this.#name === DEFAULT_INSTANCE ? 'kafka' : `kafka:${this.#name}`
  }

  #config: Partial<KafkaConfigSlice> | undefined
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
  #deadLetterSet = false
  #notRetryable?: Ctor<Error>[]
  #retryable?: Ctor<Error>[]
  #classifier?: ErrorClassifier
  #recoverer?: KafkaRecoverer
  #onDeserializationError?: DeserializationErrorHandler
  #onError?: (error: unknown, message: KafkaMessage) => void

  constructor(clients: KafkaClients, name: string = DEFAULT_INSTANCE, configure?: FeatureConfigurer<never, C>) {
    super(configure)
    this.#clients = clients
    this.#name = name
  }

  /**
   * Reads the settings from a node of the configuration tree, e.g. `c.app.kafka`.
   *
   * Applied **over** what the fluent methods set, so `k.brokers(...)` is a default a deployment can redirect.
   * The serializers, the retry strategy, the classifier, the recoverer and the error hooks are functions and
   * cannot travel through a tree — they stay on the builder and are merged in either way.
   */
  withConfig(config: Partial<KafkaConfigSlice>): this {
    this.#config = config
    return this
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

  /** Non-blocking retry via per-level topics (`${topic}-retry-N`), then dead-letter. */
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
    this.#deadLetterSet = true
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

  protected configure(kit: FeatureConfigureKit<C>): void {
    const config = this.#resolve()
    const rKey = runtimeKey(this.#name)
    const tKey = kafkaTemplate(this.#name)

    kit.container.bind(rKey, t =>
      t.toFactory((ctx): KafkaRuntime => ({
        name: this.#name,
        container: ctx.container as Container,
        config,
        clients: this.#clients,
      })),
    )

    // The default instance's template is bound under the KafkaTemplate class (so it can be injected by
    // type), carrying tKey as a name alias. Named instances bind under their name key only.
    if (this.#name === DEFAULT_INSTANCE) {
      kit.container.bind(KafkaTemplate, t => t.toClass(KafkaTemplate, [rKey]).names(tKey))
    } else {
      kit.container.bind(tKey, t => t.toClass(KafkaTemplate, [rKey]))
    }

    kit.container.bind(containerKey(this.#name), t =>
      t.toClass(KafkaListenerContainer, [rKey, tKey]).labels(Keys.KAFKA_CONTAINER),
    )

    // Registered once, covering every configured instance: starts every engine on `container.init()` and
    // stops it on `container.dispose()`. `.fallback()` so a second named instance does not fight the first.
    kit.container.bind(KafkaLifecycle, t => t.toFactory(ctx => new KafkaLifecycle(ctx.container)).fallback())

    // Registered once, covering every configured instance. Inert unless the application exposes the
    // probes, and then it is what makes readiness mean "serving HTTP *and* consuming".
    kit.container.bind(KafkaHealthIndicator, t =>
      t
        .toFactory(ctx => new KafkaHealthIndicator(ctx.container as Container))
        .extends(HealthIndicator)
        .fallback(),
    )
  }

  /**
   * The builder's settings with the configured ones folded over them, plus everything a configuration tree
   * cannot carry.
   *
   * @throws ErrKafkaMissingBrokers when no broker was named from either side. Checked here rather than on the
   *   builder: the brokers may arrive from either, so this is the first moment the answer is known.
   */
  #resolve(): ResolvedKafkaConfig {
    const brokers =
      this.#config?.brokers ??
      (this.#brokers === undefined ? undefined : Array.isArray(this.#brokers) ? [...this.#brokers] : [this.#brokers]) ??
      []

    if (brokers.length === 0 || brokers.some(broker => broker.length === 0)) {
      throw new ErrKafkaMissingBrokers()
    }

    return resolveConfig(
      {
        brokers,
        clientId: this.#config?.clientId ?? this.#clientId,
        groupId: this.#config?.groupId ?? this.#groupId,
        ackMode: this.#config?.ackMode ?? this.#ackMode,
        retry: this.#config?.retry ?? this.#retry,
        topicProvisioning: this.#config?.topicProvisioning ?? this.#topicProvisioning,
        serializers: this.#serializers,
        deserializers: this.#deserializers,
        retryStrategy: this.#retryStrategy,
        deadLetterManager: this.#deadLetterManager,
        // Named in code — including an explicit `false` — stands. Configuration fills it in only when
        // `.deadLetter(...)` was never called. The object form cannot travel through a tree either way.
        deadLetter: this.#deadLetterSet ? this.#deadLetter : (this.#config?.deadLetter ?? this.#deadLetter),
        notRetryable: this.#notRetryable,
        retryable: this.#retryable,
        classifier: this.#classifier,
        recoverer: this.#recoverer,
        onDeserializationError: this.#onDeserializationError,
        onError: this.#onError,
      } as never,
      { serializers: defaultSerializers, deserializers: defaultDeserializers },
    )
  }
}
