import { type Provider, Scopes } from '@caffeinejs/di'
import type { ConsumerClient, ConsumerStream, DeserializationErrorRecord, KafkaAckMode, KafkaConsumerEvent, KafkaConsumerEventPayload, KafkaDeserializers, KafkaMessage } from './config.js'
import { KafkaContext } from './context.js'
import { type DeserError, extractDeserError, wrapDeserializers } from './deser.js'
import { getHandlerListeners, type ListenerSpec } from './decorators/registrar.js'
import { type BackOff, buildClassifier, deadLetterRecoverer, delayFor, type ErrorClassifier, type KafkaRecoverer, sleep } from './error_handling.js'
import { ErrKafkaMissingGroupID, ErrKafkaMissingTopic, ErrKafkaNackExhausted } from './errors.js'
import { compileArgs } from './pick_compiler.js'
import type { KafkaRuntime } from './runtime.js'
import { DEFAULT_INSTANCE, Keys, kSignals } from './symbols.js'
import type { KafkaTemplate } from './template.js'

type HandlerInstance = Record<string | symbol, (...args: unknown[]) => unknown>

/** Lifecycle state of a {@link KafkaListenerContainer}, for health checks. */
export type KafkaContainerStatus = 'idle' | 'starting' | 'running' | 'rebalancing' | 'stopped'

type EventListener = (payload: KafkaConsumerEventPayload) => void

/** The resolved error-handling policy for one route (per-listener overrides folded over instance defaults). */
interface RouteErrorHandling {
  attempts: number
  backoff?: BackOff
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
}

/**
 * The per-instance runtime engine. One is bound (labelled {@link Keys.KAFKA_CONTAINER}) by each
 * {@link KafkaBuilder}; the plugin drives every engine's {@link start}/{@link stop} from `application:run` /
 * `application:pre-shutdown`. {@link start} enumerates the `@KafkaHandler` classes tagged for this instance,
 * groups their `@KafkaListener` methods by group id, creates one consumer per group, and dispatches each
 * message to the matching handler method (extracting arguments via `@KafkaParams`, or the whole message by
 * default). {@link stop} closes every consumer and this instance's producer.
 */
export class KafkaListenerContainer {
  readonly #runtime: KafkaRuntime
  readonly #template: KafkaTemplate
  readonly #consumers: ConsumerClient[] = []
  readonly #streams: ConsumerStream[] = []
  readonly #listeners = new Map<KafkaConsumerEvent, Set<EventListener>>()
  #status: KafkaContainerStatus = 'idle'
  #running = false

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

  /** Wires and starts one consumer per group. Idempotent. */
  async start(): Promise<void> {
    if (this.#running) {
      return
    }
    this.#running = true
    this.#status = 'starting'

    for (const group of this.#plan().values()) {
      const consumer = this.#runtime.clients.createConsumer(this.#runtime.config, group.groupId)
      this.#consumers.push(consumer)
      this.#forwardEvents(consumer)

      // In record/manual ack modes the engine owns commits, so platformatic autocommit is disabled.
      const autocommit = this.#runtime.config.ackMode === 'auto' ? group.autocommit : false
      const deserializers = wrapDeserializers(group.deserializers ?? this.#runtime.config.deserializers)
      const stream = await consumer.consume({ topics: [...group.topics], autocommit, deserializers })
      this.#streams.push(stream)

      this.#pump(stream, group, consumer)
    }

    this.#status = 'running'
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
          group = { groupId, deserializers, topics: new Set(), autocommit: spec.autocommit, routes: new Map() }
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
        }
      }
    }

    return groups
  }

  // Consumes the stream and dispatches each message to its topic's routes. Runs detached; iteration ends
  // cleanly when the stream is closed during shutdown.
  #pump(stream: ConsumerStream, group: Group, consumer: ConsumerClient): void {
    void (async () => {
      for await (const message of stream) {
        const deserError = extractDeserError(message)
        if (deserError !== undefined) {
          await this.#handleDeserError(deserError, message)
          continue
        }

        const routes = group.routes.get(message.topic)
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
          })
          await this.#dispatch(route, message, context)
        }
      }
    })()
  }

  // Folds the per-listener overrides over the instance-default error handling into one resolved policy.
  #errorHandling(spec: ListenerSpec): RouteErrorHandling {
    const config = this.#runtime.config
    const retry = spec.retry ?? config.retry
    const deadLetter = spec.deadLetter ?? config.deadLetter

    let recover = config.recoverer
    if (recover === undefined && deadLetter !== undefined && deadLetter !== false) {
      recover = deadLetterRecoverer(this.#template, typeof deadLetter === 'object' ? deadLetter : {})
    }

    return {
      attempts: Math.max(1, retry?.attempts ?? 1),
      backoff: retry?.backoff,
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

  // The dispatch pipeline: retry with backoff, classification, then recovery. Re-uses one KafkaContext across
  // attempts (its `attempt` advances). `ctx.nack()` re-runs in-process; `ctx.ack()` drives manual commit.
  async #dispatch(route: Route, message: KafkaMessage, context: KafkaContext): Promise<void> {
    const eh = route.errorHandling
    const signals = context[kSignals]

    for (let attempt = 1; ; attempt++) {
      signals.attempt = attempt
      signals.acked = false
      signals.nacked = false
      signals.nackDelay = undefined

      try {
        await this.#invoke(route, message, context)
      } catch (error) {
        if (eh.classify(error, attempt) && attempt < eh.attempts) {
          await sleep(delayFor(eh.backoff, attempt))
          continue
        }
        await this.#recover(eh, message, error, context)
        return
      }

      if (signals.nacked) {
        if (attempt < eh.attempts) {
          await sleep(signals.nackDelay ?? delayFor(eh.backoff, attempt))
          continue
        }
        await this.#recover(eh, message, new ErrKafkaNackExhausted(message.topic, attempt), context)
        return
      }

      await this.#commitAfterSuccess(eh.ackMode, message, signals.acked)
      return
    }
  }

  #invoke(route: Route, message: KafkaMessage, context: KafkaContext): Promise<void> {
    const run = async (): Promise<void> => {
      const args = await route.extract(message, context)
      const instance = route.provider.get()
      await instance[route.handlerName](...args)
    }
    return route.requestScoped ? this.#runtime.container.requestScopeManager.run(run) : run()
  }

  // Terminal path: notify the observation hook, run the recoverer (best-effort), advance past the record.
  async #recover(
    eh: RouteErrorHandling,
    message: KafkaMessage,
    error: unknown,
    context: KafkaContext,
  ): Promise<void> {
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

    if (eh.ackMode !== 'auto') {
      await message.commit()
    }
  }

  async #commitAfterSuccess(ackMode: KafkaAckMode, message: KafkaMessage, acked: boolean): Promise<void> {
    // `auto` leaves commits to platformatic autocommit; `manual` relies on the handler's ctx.ack().
    if (ackMode === 'record' && !acked) {
      await message.commit()
    }
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
