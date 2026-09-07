import type { Ctor } from '@caffeinejs/di'
import {
  HealthIndicator,
  type ServiceBeforeBootstrapIn,
  type Service,
  type ServiceAPI,
  type ServiceBootstrapIn,
} from '@caffeinejs/std'
import { defineFeatureConfig, type ConfigAccessors, type ConfigHandle, type ConfigSlice } from '@caffeinejs/std/config'

import { defaultDeserializers, defaultSerializers } from './clients.js'
import {
  kafkaConfigSchema,
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
import { KafkaListenerContainer } from './listener_container.js'
import type { DeadLetterManager } from './retry/dead_letter_manager.js'
import { retryTopics, type RetryStrategy, type RetryTopicOptions, sharedRetryTopic } from './retry/strategy.js'
import type { KafkaRuntime } from './runtime.js'
import { containerKey, DEFAULT_INSTANCE, kafkaTemplate, Keys, runtimeKey } from './symbols.js'
import { KafkaTemplate } from './template.js'

/**
 * Fluent configuration for one (optionally named) Kafka integration. Follows the repo feature-builder
 * convention (`.extend(kafka, k => k.brokers(...).groupId(...))`): it accumulates settings, then at `ready()`
 * time its `configure()` binds this instance's runtime, `KafkaTemplate`, and `KafkaListenerContainer` into
 * the container under per-instance keys. A second integration is `.extend(kafka('orders'), k => ...)`.
 *
 * There is one read path for everything a configuration tree can carry. A builder method does not hold its
 * value — it writes into the tree in the `CODE` band, and the instance reads the merged result. So
 * `k.brokers('localhost:9092')` is a **default**: `KAFKA__DEFAULT__BROKERS=broker.prod:9092` overrides it, and
 * one image ships to every environment. The members that cannot be configuration — serializers, the
 * classifier, the recoverer, the error hooks — stay on the builder and are merged in afterwards.
 *
 * Settings live at `kafka.<name>.*`, the unnamed instance at `kafka.default.*`. {@link config} re-points them.
 *
 * `C` is the application config type, recovered from the builder `.extend(kafka, …)` was reached through, so the
 * selector argument is a `ConfigHandle<C>`.
 */
export class KafkaBuilder<C = unknown> implements Service {
  readonly #name: string
  readonly #clients: KafkaClients
  #selector?: (c: ConfigHandle<C>) => ConfigAccessors<KafkaConfigSlice>
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
  #resolved?: ConfigSlice<ResolvedKafkaConfig>

  constructor(clients: KafkaClients, name: string = DEFAULT_INSTANCE) {
    this.#clients = clients
    this.#name = name
  }

  get name(): string {
    return 'kafka'
  }

  /** One or more `host:port` bootstrap brokers. Required. */
  brokers(brokers: string | string[]): ServiceAPI<this> {
    this.#brokers = brokers
    return this
  }

  /** Client identifier reported to the broker. */
  clientId(clientId: string): ServiceAPI<this> {
    this.#clientId = clientId
    return this
  }

  /** Default consumer group id for listeners that do not declare their own. */
  groupId(groupId: string): ServiceAPI<this> {
    this.#groupId = groupId
    return this
  }

  /** Overrides the default producer serializers (`{ key: string, value: json }`). */
  serializers(serializers: KafkaSerializers): ServiceAPI<this> {
    this.#serializers = serializers
    return this
  }

  /** Overrides the default consumer deserializers (`{ key: string, value: json }`). */
  deserializers(deserializers: KafkaDeserializers): ServiceAPI<this> {
    this.#deserializers = deserializers
    return this
  }

  /** Commit strategy: `auto` (default), `record` (commit after each success), or `manual` (`ctx.ack()`). */
  ackMode(mode: KafkaAckMode): ServiceAPI<this> {
    this.#ackMode = mode
    return this
  }

  /** Instance-default retry policy for failing handlers (blocking, in-process retry). */
  retry(policy: RetryPolicy): ServiceAPI<this> {
    this.#retry = policy
    return this
  }

  /** Sets an explicit instance-default retry strategy (blocking, retry-topics, or custom); overrides `retry`. */
  retryStrategy(strategy: RetryStrategy): ServiceAPI<this> {
    this.#retryStrategy = strategy
    return this
  }

  /** Non-blocking retry via per-level topics (`${topic}-retry-N`), then dead-letter. */
  retryTopics(policy: RetryPolicy, options?: RetryTopicOptions): ServiceAPI<this> {
    this.#retryStrategy = retryTopics(policy, options)
    return this
  }

  /** Non-blocking retry via a single shared `${topic}-retry` topic (attempt/delay carried in headers). */
  sharedRetryTopic(policy: RetryPolicy, options?: RetryTopicOptions): ServiceAPI<this> {
    this.#retryStrategy = sharedRetryTopic(policy, options)
    return this
  }

  /** Configures auto-creation of the retry/dead-letter topics (partitions/replicas, or opt-out). */
  topicProvisioning(options: TopicProvisioning): ServiceAPI<this> {
    this.#topicProvisioning = options
    return this
  }

  /** Overrides the built-in dead-letter manager (inspect/purge/re-inject) for this instance. */
  deadLetterManager(manager: DeadLetterManager): ServiceAPI<this> {
    this.#deadLetterManager = manager
    return this
  }

  /** Enables dead-letter recovery (default `${topic}.DLT`) once retries are exhausted. */
  deadLetter(options: DeadLetterOptions | boolean = true): ServiceAPI<this> {
    this.#deadLetter = options
    return this
  }

  /** Exceptions that must never be retried. */
  notRetryable(...errors: Ctor<Error>[]): ServiceAPI<this> {
    this.#notRetryable = [...(this.#notRetryable ?? []), ...errors]
    return this
  }

  /** If set, only these exceptions are retried. */
  retryable(...errors: Ctor<Error>[]): ServiceAPI<this> {
    this.#retryable = [...(this.#retryable ?? []), ...errors]
    return this
  }

  /** Full control over retry classification; wins over `notRetryable`/`retryable`. */
  classifier(classifier: ErrorClassifier): ServiceAPI<this> {
    this.#classifier = classifier
    return this
  }

  /** Terminal recoverer after retries are exhausted; overrides the built-in dead-letter recoverer. */
  recoverer(recoverer: KafkaRecoverer): ServiceAPI<this> {
    this.#recoverer = recoverer
    return this
  }

  /** Handles records that fail deserialization (routed here instead of the listener). */
  onDeserializationError(handler: DeserializationErrorHandler): ServiceAPI<this> {
    this.#onDeserializationError = handler
    return this
  }

  /** Observation hook invoked when the pipeline gives up on a message (logging/metrics). */
  onError(onError: (error: unknown, message: KafkaMessage) => void): ServiceAPI<this> {
    this.#onError = onError
    return this
  }

  /**
   * Places this instance's settings elsewhere in the configuration tree, e.g. `k.config(c => c.app.events)`.
   *
   * The selector names a location, not a value: it is evaluated once, at configure time, to record the path.
   * Both the reads and the defaults written by the builder methods follow it.
   */
  config(selector: (c: ConfigHandle<C>) => ConfigAccessors<KafkaConfigSlice>): ServiceAPI<this> {
    this.#selector = selector
    return this
  }

  beforeBootstrap(kit: ServiceBeforeBootstrapIn): void {
    const slice = defineFeatureConfig<KafkaConfigSlice>(kit.config, {
      selector: this.#selector as ((c: never) => unknown) | undefined,
      schema: kafkaConfigSchema,
      values: {
        // A builder method is a default: `KAFKA__DEFAULT__BROKERS` overrides whatever `.brokers(...)` set.
        brokers:
          this.#brokers === undefined ? undefined : Array.isArray(this.#brokers) ? [...this.#brokers] : [this.#brokers],
        clientId: this.#clientId,
        groupId: this.#groupId,
        ackMode: this.#ackMode,
        retry: this.#retry === undefined ? undefined : { ...this.#retry },
        topicProvisioning: this.#topicProvisioning === undefined ? undefined : { ...this.#topicProvisioning },
        // Only the boolean form can travel through a config tree; the object form is two callbacks.
        deadLetter: typeof this.#deadLetter === 'boolean' ? this.#deadLetter : undefined,
      },
    })

    // Everything a configuration tree cannot carry, folded back in when the slice publishes.
    const code = {
      serializers: this.#serializers,
      deserializers: this.#deserializers,
      retryStrategy: this.#retryStrategy,
      deadLetterManager: this.#deadLetterManager,
      deadLetter: typeof this.#deadLetter === 'object' ? this.#deadLetter : undefined,
      notRetryable: this.#notRetryable,
      retryable: this.#retryable,
      classifier: this.#classifier,
      recoverer: this.#recoverer,
      onDeserializationError: this.#onDeserializationError,
      onError: this.#onError,
    }

    this.#resolved = slice.derive(published => {
      const brokers = published.brokers ?? []

      // Checked here rather than on the builder: the brokers may arrive from any source, so the only moment
      // the answer is known is once the whole chain has merged. The failure surfaces as the slice's, naming
      // the instance that could not be configured.
      if (brokers.length === 0 || brokers.some(broker => broker.length === 0)) {
        throw new ErrKafkaMissingBrokers()
      }

      return resolveConfig(
        {
          ...published,
          brokers,
          ...code,
          // `code.deadLetter` is only the object form; a `false` from configuration must still be honoured.
          deadLetter: code.deadLetter ?? published.deadLetter,
        },
        { serializers: defaultSerializers, deserializers: defaultDeserializers },
      )
    })
  }

  bootstrap(kit: ServiceBootstrapIn): Promise<void> {
    const resolved = this.#resolved!
    const rKey = runtimeKey(this.#name)
    const tKey = kafkaTemplate(this.#name)
    const container = kit.container

    kit.container.bind(rKey, t =>
      t
        // The config object is the slice's own and is live, so a refresh reaches whatever reads through it.
        .toValue<KafkaRuntime>({
          name: this.#name,
          container,
          config: resolved.config,
          clients: this.#clients,
        }),
    )

    // The default instance's template is bound under the KafkaTemplate class (so it can be injected by type),
    // carrying tKey as a name alias. Named instances bind under their name key only.
    if (this.#name === DEFAULT_INSTANCE) {
      kit.container.bind(KafkaTemplate, t => t.toClass(KafkaTemplate, [rKey]).names(tKey))
    } else {
      kit.container.bind(tKey, t => t.toClass(KafkaTemplate, [rKey]))
    }

    kit.container.bind(containerKey(this.#name), t =>
      t.toClass(KafkaListenerContainer, [rKey, tKey]).labels(Keys.KAFKA_CONTAINER),
    )

    // Registered once, covering every configured instance. Inert unless the application exposes the probes, and
    // then it is what makes readiness mean "serving HTTP *and* consuming" rather than "the port is open".
    if (!kit.container.has(KafkaHealthIndicator)) {
      const container = kit.container
      kit.container.bind(KafkaHealthIndicator, t =>
        t.toFactory(() => new KafkaHealthIndicator(container)).extends(HealthIndicator),
      )
    }

    return Promise.resolve()
  }
}
