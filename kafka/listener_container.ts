import { type Provider, Scopes } from '@caffeinejs/di'

import type {
  ConsumerClient,
  ConsumerStream,
  DeserializationErrorRecord,
  KafkaAckMode,
  KafkaConsumerEvent,
  KafkaConsumerEventPayload,
  KafkaDeserializers,
  KafkaMessage,
  TopicSpec,
} from './config.js'
import { KafkaContext } from './context.js'
import { getHandlerListeners, type ListenerSpec } from './decorators/registrar.js'
import { type DeserError, extractDeserError, wrapDeserializers } from './deser.js'
import {
  buildClassifier,
  deadLetterRecoverer,
  type ErrorClassifier,
  type KafkaRecoverer,
  sleep,
} from './error_handling.js'
import { ErrKafkaMissingGroupID, ErrKafkaMissingTopic } from './errors.js'
import { compileArgs } from './pick_compiler.js'
import { type DeadLetterManager, deadLetterManager } from './retry/dead_letter_manager.js'
import { blockingRetry, type RetryDelivery, type RetryStrategy, type RetryTopic } from './retry/strategy.js'
import type { KafkaRuntime } from './runtime.js'
import { DEFAULT_INSTANCE, Keys, kSignals, RetryHeaders } from './symbols.js'
import type { KafkaTemplate } from './template.js'

type HandlerInstance = Record<string | symbol, (...args: unknown[]) => unknown>

/** Lifecycle state of a {@link KafkaListenerContainer}, for health checks. */
export type KafkaContainerStatus = 'idle' | 'starting' | 'running' | 'rebalancing' | 'stopped'

type EventListener = (payload: KafkaConsumerEventPayload) => void

/** The resolved error-handling policy for one route (per-listener overrides folded over instance defaults). */
interface RouteErrorHandling {
  strategy: RetryStrategy
  classify: ErrorClassifier
  recover?: KafkaRecoverer
  onError?: (error: unknown, message: KafkaMessage) => void
  ackMode: KafkaAckMode
}

/** A resolved dispatch target: which class, which method, how to obtain the instance, and how to pick args. */
interface Route {
  handlerName: string | symbol
  provider: Provider<HandlerInstance>
  requestScoped: boolean
  extract: (message: KafkaMessage, context: KafkaContext) => unknown[] | Promise<unknown[]>
  errorHandling: RouteErrorHandling
}

/** A consumer group: one platformatic `Consumer` subscribed to the union of its listeners' topics. */
interface Group {
  groupId: string
  deserializers?: KafkaDeserializers
  topics: Set<string>
  autocommit?: boolean | number
  routes: Map<string, Route[]>
  /** Retry topics (delay tiers) this group's strategies declare, keyed by retry-topic name, with their source. */
  retryTopics: Map<string, { spec: RetryTopic; source: string }>
  /** Dead-letter topics this group's strategies target, keyed by DLT name → its source topic (for provisioning). */
  deadLetterTopics: Map<string, string>
}

/**
 * The per-instance runtime engine. One is bound (labelled {@link Keys.KAFKA_CONTAINER}) by each
 * {@link KafkaBuilder}; `KafkaLifecycle` drives every engine's {@link start}/{@link stop} from
 * `container.init()` / `container.dispose()`. {@link start} enumerates the `@KafkaHandler` classes tagged for
 * this instance,
 * groups their `@KafkaListener` methods by group id, creates one consumer per group (plus an isolated retry
 * consumer when a non-blocking retry strategy declares retry topics), and dispatches each message through the
 * route's {@link RetryStrategy}. {@link stop} closes every consumer and this instance's producer.
 */
export class KafkaListenerContainer {
  readonly #runtime: KafkaRuntime
  readonly #template: KafkaTemplate
  readonly #consumers: ConsumerClient[] = []
  readonly #streams: ConsumerStream[] = []
  readonly #listeners = new Map<KafkaConsumerEvent, Set<EventListener>>()
  #status: KafkaContainerStatus = 'idle'
  #running = false
  #dlq?: DeadLetterManager

  constructor(runtime: KafkaRuntime, template: KafkaTemplate) {
    this.#runtime = runtime
    this.#template = template
  }

  /** The name of the kafka instance this engine serves. */
  get name(): string {
    return this.#runtime.name
  }

  /** The current lifecycle state, for health checks. */
  status(): KafkaContainerStatus {
    return this.#status
  }

  /** The dead-letter manager (inspect/purge/re-inject) for this instance — the builtin, or a configured override. */
  deadLetters(): DeadLetterManager {
    this.#dlq ??= this.#runtime.config.deadLetterManager ?? deadLetterManager(this.#runtime, this.#template)
    return this.#dlq
  }

  /** Subscribes to a consumer lifecycle event across every consumer this engine owns. */
  on(event: KafkaConsumerEvent, listener: EventListener): this {
    let set = this.#listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  /** Removes a previously registered lifecycle listener. */
  off(event: KafkaConsumerEvent, listener: EventListener): this {
    this.#listeners.get(event)?.delete(listener)
    return this
  }

  #emit(event: KafkaConsumerEvent, payload: KafkaConsumerEventPayload): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      listener(payload)
    }
  }

  /** Wires and starts one consumer per group (plus a retry consumer when needed). Idempotent. */
  async start(): Promise<void> {
    if (this.#running) {
      return
    }
    this.#running = true
    this.#status = 'starting'

    const plan = this.#plan()
    await this.#provision(plan)

    for (const group of plan.values()) {
      // In record/manual ack modes the engine owns commits, so platformatic autocommit is disabled.
      const autocommit = this.#runtime.config.ackMode === 'auto' ? group.autocommit : false
      const deserializers = wrapDeserializers(group.deserializers ?? this.#runtime.config.deserializers)
      await this.#openConsumer(group, group.groupId, [...group.topics], autocommit, deserializers)

      // Retry topics get their own consumer + group so their block-and-sleep delay never stalls the main topic.
      // They carry the instance's wire format (the template re-serialized the record), so use its deserializers.
      if (group.retryTopics.size > 0) {
        const retryAutocommit = this.#runtime.config.ackMode === 'auto'
        const retryDeser = wrapDeserializers(this.#runtime.config.deserializers)
        await this.#openConsumer(
          group,
          `${group.groupId}-retry`,
          [...group.retryTopics.keys()],
          retryAutocommit,
          retryDeser,
        )
      }
    }

    this.#status = 'running'
  }

  async #openConsumer(
    group: Group,
    groupId: string,
    topics: string[],
    autocommit: boolean | number | undefined,
    deserializers: KafkaDeserializers,
  ): Promise<void> {
    const consumer = this.#runtime.clients.createConsumer(this.#runtime.config, groupId)
    this.#consumers.push(consumer)
    this.#forwardEvents(consumer)

    const stream = await consumer.consume({ topics, autocommit, deserializers })
    this.#streams.push(stream)

    this.#pump(stream, group, consumer)
  }

  // Auto-creates the retry/dead-letter topics the plan's strategies declared, unless provisioning is disabled or
  // the client factory exposes no admin. Each topic's partition count is resolved by precedence:
  // strategy-explicit → instance-config-explicit → inherited from the source topic → 1. NOTE: createTopics is
  // idempotent-ignore, so this will NOT grow the partitions of a retry topic a prior run created at a lower count.
  async #provision(plan: Map<string, Group>): Promise<void> {
    const provisioning = this.#runtime.config.topicProvisioning
    if (!provisioning.autoCreate) {
      return
    }

    // Each topic to create with its source (for inheritance) and any strategy-explicit partition override.
    const wanted = new Map<string, { source: string; explicit?: number }>()
    const sources = new Set<string>()
    for (const group of plan.values()) {
      for (const { spec, source } of group.retryTopics.values()) {
        wanted.set(spec.topic, { source, explicit: spec.partitions })
        sources.add(source)
      }
      for (const [dltTopic, source] of group.deadLetterTopics) {
        if (!wanted.has(dltTopic)) {
          wanted.set(dltTopic, { source })
          sources.add(source)
        }
      }
    }

    if (wanted.size === 0) {
      return
    }
    const admin = this.#runtime.clients.createAdmin?.(this.#runtime.config)
    if (admin === undefined) {
      return
    }
    try {
      const counts = (await admin.partitionCounts?.([...sources])) ?? new Map<string, number>()
      const specs: TopicSpec[] = [...wanted].map(([topic, { source, explicit }]) => ({
        topic,
        partitions: explicit ?? provisioning.partitions ?? counts.get(source) ?? 1,
        replicas: provisioning.replicas,
      }))
      await admin.createTopics(specs)
    } finally {
      await admin.close()
    }
  }

  // Bridges a consumer's normalized lifecycle events to this engine's listeners + status.
  #forwardEvents(consumer: ConsumerClient): void {
    if (consumer.on === undefined) {
      return
    }
    const events: KafkaConsumerEvent[] = ['join', 'leave', 'rebalance', 'connect', 'disconnect', 'lag']
    for (const event of events) {
      consumer.on(event, payload => {
        if (event === 'rebalance') {
          this.#status = 'rebalancing'
        } else if (event === 'join' && this.#running) {
          this.#status = 'running'
        }
        this.#emit(event, payload)
      })
    }
  }

  /** Closes every consumer stream, consumer, and the producer. Idempotent. */
  async stop(): Promise<void> {
    this.#running = false
    this.#status = 'stopped'

    for (const stream of this.#streams) {
      await stream.close()
    }
    for (const consumer of this.#consumers) {
      await consumer.close()
    }
    this.#streams.length = 0
    this.#consumers.length = 0

    await this.#template.close()
  }

  // Builds the consumer plan from the labelled handler classes: one consumer per (groupId, deserializers), each
  // holding a topic -> routes map so a single consumer can fan a message out to every listener on that topic.
  // Retry/dead-letter topics each route's strategy declares are collected onto the group for provisioning and
  // for the isolated retry consumer.
  #plan(): Map<string, Group> {
    const container = this.#runtime.container
    const groups = new Map<string, Group>()
    // Distinct deserializer configs get distinct consumers even within the same group id.
    const deserIds = new Map<KafkaDeserializers, number>()

    for (const { key, binding } of container.getBindingsByLabel(Keys.KAFKA_HANDLER)) {
      // Only handlers tagged for this instance (untagged handlers belong to the default instance).
      const instance = (binding.tags.get(Keys.KAFKA_INSTANCE) as string | undefined) ?? DEFAULT_INSTANCE
      if (instance !== this.#runtime.name) {
        continue
      }

      const specs = getHandlerListeners(binding.type as Function)
      const requestScoped = container.hasScopeInGraph(key, Scopes.REQUEST)

      for (const spec of specs) {
        if (spec.topics.length === 0) {
          throw new ErrKafkaMissingTopic(String(spec.handlerName))
        }

        const groupId = spec.groupId ?? this.#runtime.config.groupId
        if (groupId === undefined) {
          throw new ErrKafkaMissingGroupID(String(spec.handlerName))
        }

        const deserializers = spec.deserializers ?? this.#runtime.config.deserializers
        let deserId = deserIds.get(deserializers)
        if (deserId === undefined) {
          deserId = deserIds.size
          deserIds.set(deserializers, deserId)
        }
        const groupKey = `${groupId}::${deserId}`

        let group = groups.get(groupKey)
        if (group === undefined) {
          group = {
            groupId,
            deserializers,
            topics: new Set(),
            autocommit: spec.autocommit,
            routes: new Map(),
            retryTopics: new Map(),
            deadLetterTopics: new Map(),
          }
          groups.set(groupKey, group)
        }

        const route: Route = {
          handlerName: spec.handlerName,
          provider: container.wrapBinding<HandlerInstance>(binding),
          requestScoped,
          extract: compileArgs(spec.parameters),
          errorHandling: this.#errorHandling(spec),
        }

        for (const topic of spec.topics) {
          group.topics.add(topic)
          let routes = group.routes.get(topic)
          if (routes === undefined) {
            routes = []
            group.routes.set(topic, routes)
          }
          routes.push(route)

          // Collect the strategy's retry + dead-letter topics, remembering the source topic each derives from
          // (provisioning inherits its partition count).
          for (const retryTopic of route.errorHandling.strategy.topics(topic)) {
            group.retryTopics.set(retryTopic.topic, { spec: retryTopic, source: topic })
          }
          const dlt = route.errorHandling.strategy.deadLetterTopic?.(topic)
          if (dlt !== undefined && !group.deadLetterTopics.has(dlt)) {
            group.deadLetterTopics.set(dlt, topic)
          }
        }
      }
    }

    return groups
  }

  // Consumes the stream and dispatches each message to its topic's routes. Runs detached; iteration ends
  // cleanly when the stream is closed during shutdown. Retry-topic records carry the origin topic + attempt in
  // headers, so routing is by the source topic, not the (possibly retry) topic the record arrived on.
  #pump(stream: ConsumerStream, group: Group, consumer: ConsumerClient): void {
    void (async () => {
      for await (const message of stream) {
        const deserError = extractDeserError(message)
        if (deserError !== undefined) {
          await this.#handleDeserError(deserError, message)
          continue
        }

        // The `x-original-topic` header only redirects routing on the engine's own retry topics. Elsewhere the
        // header is provenance metadata (a dead-letter listener must route by its actual topic, not the origin),
        // so a record on any non-retry topic dispatches by `message.topic` at attempt 1.
        const onRetryTopic = group.retryTopics.has(message.topic)
        const origin = message.headers.get(RetryHeaders.ORIGINAL_TOPIC) ?? message.topic
        const sourceTopic = onRetryTopic ? origin : message.topic
        const attempt = onRetryTopic ? Number(message.headers.get(RetryHeaders.ATTEMPT) ?? '1') : 1

        const routes = group.routes.get(sourceTopic)
        if (routes === undefined) {
          continue
        }

        for (const route of routes) {
          const context = new KafkaContext({
            message,
            groupId: group.groupId,
            instance: this.#runtime.name,
            consumer,
            stream,
            template: this.#template,
            sourceTopic,
            attempt,
          })
          await this.#dispatch(route, message, context, sourceTopic, attempt)
        }
      }
    })()
  }

  // Folds the per-listener overrides over the instance-default error handling into one resolved policy. The
  // retry mechanism is a pluggable strategy; a plain `retry` policy becomes blocking retry (v3 behaviour).
  #errorHandling(spec: ListenerSpec): RouteErrorHandling {
    const config = this.#runtime.config
    const deadLetter = spec.deadLetter ?? config.deadLetter

    let recover = config.recoverer
    if (recover === undefined && deadLetter !== undefined && deadLetter !== false) {
      recover = deadLetterRecoverer(this.#template, typeof deadLetter === 'object' ? deadLetter : {})
    }

    const strategy =
      spec.retryStrategy ??
      (spec.retry !== undefined ? blockingRetry(spec.retry) : undefined) ??
      config.retryStrategy ??
      blockingRetry(config.retry ?? { attempts: 1 })

    return {
      strategy,
      classify: buildClassifier({
        notRetryable: config.notRetryable,
        retryable: config.retryable,
        classifier: config.classifier,
      }),
      recover,
      onError: config.onError,
      ackMode: config.ackMode,
    }
  }

  // Hands one delivery to the route's retry strategy, exposing the invoke/classify/forward/recover/commit
  // primitives as closures over this route, message, and context.
  #dispatch(
    route: Route,
    message: KafkaMessage,
    context: KafkaContext,
    sourceTopic: string,
    attempt: number,
  ): Promise<void> {
    const eh = route.errorHandling
    const signals = context[kSignals]

    const delivery: RetryDelivery = {
      message,
      sourceTopic,
      initialAttempt: attempt,
      get acked(): boolean {
        return signals.acked
      },
      get nacked(): boolean {
        return signals.nacked
      },
      get nackDelay(): number | undefined {
        return signals.nackDelay
      },
      reset: (n: number): void => {
        signals.attempt = n
        signals.acked = false
        signals.nacked = false
        signals.nackDelay = undefined
      },
      invoke: (): Promise<void> => this.#invoke(route, message, context),
      classify: (error: unknown, n: number): boolean => eh.classify(error, n),
      sleepUntilReady: async (): Promise<void> => {
        const notBefore = message.headers.get(RetryHeaders.NOT_BEFORE)
        if (notBefore === undefined) {
          return
        }
        await sleep(Number(notBefore) - Date.now())
      },
      forward: async (topic: string, extra?: Record<string, string>): Promise<void> => {
        const headers: Record<string, string> = {}
        for (const [headerKey, value] of message.headers) {
          headers[headerKey] = value
        }
        headers[RetryHeaders.ORIGINAL_TOPIC] = sourceTopic
        Object.assign(headers, extra)
        await this.#template.sendMessage({ topic, key: message.key, value: message.value, headers })
      },
      recover: async (error: unknown): Promise<void> => {
        eh.onError?.(error, message)
        if (eh.recover !== undefined) {
          try {
            await eh.recover(message, error, {
              attempt: context.attempt,
              groupId: context.groupId,
              instance: context.instance,
            })
          } catch (recoverError) {
            eh.onError?.(recoverError, message)
          }
        }
      },
      commitSuccess: async (): Promise<void> => {
        // `auto` leaves commits to platformatic autocommit; `manual` relies on the handler's ctx.ack().
        if (eh.ackMode === 'record' && !signals.acked) {
          await message.commit()
        }
      },
      commitAdvance: async (): Promise<void> => {
        if (eh.ackMode !== 'auto') {
          await message.commit()
        }
      },
    }

    return eh.strategy.dispatch(delivery)
  }

  #invoke(route: Route, message: KafkaMessage, context: KafkaContext): Promise<void> {
    const run = async (): Promise<void> => {
      const args = await route.extract(message, context)
      const instance = route.provider.get()
      await instance[route.handlerName](...args)
    }
    return route.requestScoped ? this.#runtime.container.requestScopeManager.run(run) : run()
  }

  // A record whose key/value failed to deserialize never reaches the listener — it goes to the dedicated
  // deserialization-error handler (falling back to the observation hook), then the offset is advanced.
  async #handleDeserError(deserError: DeserError, message: KafkaMessage): Promise<void> {
    const config = this.#runtime.config
    const record: DeserializationErrorRecord = {
      topic: message.topic,
      partition: message.partition,
      offset: message.offset,
      rawValue: deserError.raw,
      headers: message.headers,
    }

    try {
      if (config.onDeserializationError !== undefined) {
        await config.onDeserializationError(deserError.error, record)
      } else {
        config.onError?.(deserError.error, message)
      }
    } catch (error) {
      config.onError?.(error, message)
    }

    if (config.ackMode !== 'auto') {
      await message.commit()
    }
  }
}
