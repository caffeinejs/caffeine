import { validateSchema } from '@caffeinejs/std/schema'
import type { BoundConsumer, DeliveryControl } from './binder.js'
import type { ConsumerBinding } from './binding.js'
import type { MessageBus } from './bus.js'
import type { MessageContext } from './context.js'
import { kSignals, MessageContextImpl } from './context.js'
import { getHandlerConsumes } from './decorators/registrar.js'
import { buildClassifier, type ErrorClassifier, type RecoverContext } from './error_handling.js'
import { ErrNoConsumer, ErrUnknownBinder } from './errors.js'
import type { Message } from './message.js'
import { compileArgs } from './pick_compiler.js'
import { blockingRetry, type RetryDelivery } from './retry.js'
import type { MessagingRuntime } from './runtime.js'
import { Keys } from './symbols.js'

/** One resolved `@Consume` target: a handler instance, the method to invoke, and its compiled arg extractor. */
interface Route {
  instance: Record<string, (...args: unknown[]) => unknown>
  method: string
  extract: (message: Message, context: MessageContext) => unknown[] | Promise<unknown[]>
}

/**
 * The messaging dispatch engine — the portable counterpart of Kafka's `KafkaListenerContainer`, but binder-
 * agnostic. At `start()` it discovers every `@Consume` handler, validates each targets a registered inbound
 * binding on a registered binder, then opens one consumer per inbound binding. Each consumed message is driven
 * through the resolved `RetryStrategy` over the binder-supplied {@link DeliveryControl}.
 */
export class MessagingContainer {
  readonly #runtime: MessagingRuntime
  readonly #bus: MessageBus
  readonly #consumers: BoundConsumer[] = []
  #started = false

  constructor(runtime: MessagingRuntime, bus: MessageBus) {
    this.#runtime = runtime
    this.#bus = bus
  }

  async start(): Promise<void> {
    if (this.#started) {
      return
    }

    const routes = this.#plan()

    // Fail fast before opening anything: every inbound binding must name a registered binder AND have a
    // handler. A routeless inbound binding would consume without ever committing — a stalled partition.
    for (const binding of this.#runtime.inbound.values()) {
      if (!this.#runtime.binders.has(binding.via)) {
        throw new ErrUnknownBinder(binding.binding, binding.via, [...this.#runtime.binders.keys()])
      }
      if ((routes.get(binding.binding) ?? []).length === 0) {
        throw new ErrNoConsumer(binding.binding)
      }
    }

    // Eagerly open producers so a mis-wired outbound binding fails at startup, not on first send.
    await this.#bus.warmUp()

    for (const binding of this.#runtime.inbound.values()) {
      const binder = this.#runtime.binders.get(binding.via)!
      const bindingRoutes = routes.get(binding.binding) ?? []
      const consumer = await binder.startConsumer(binding, this.#dispatch(binding, bindingRoutes))
      this.#consumers.push(consumer)
    }

    // Mark started only after every consumer is open, so a failed start() can be retried after a fix.
    this.#started = true
  }

  async stop(): Promise<void> {
    for (const consumer of this.#consumers) {
      await consumer.stop()
    }
    this.#consumers.length = 0
    for (const binder of this.#runtime.binders.values()) {
      await binder.stop()
    }
    this.#started = false
  }

  // Discovers @Consume handlers and indexes them by binding name, validating each binding exists inbound.
  #plan(): Map<string, Route[]> {
    const routes = new Map<string, Route[]>()

    for (const { binding } of this.#runtime.container.getBindingsByLabel(Keys.MESSAGE_HANDLER)) {
      const instance = this.#runtime.container
        .wrapBinding<Record<string, (...args: unknown[]) => unknown>>(binding)
        .get()

      for (const spec of getHandlerConsumes(binding.type as object)) {
        // A binding not in this integration's registry may belong to another messaging() integration; skip it
        // here rather than failing — this integration only wires the bindings it declared.
        if (!this.#runtime.inbound.has(spec.binding)) {
          continue
        }
        const list = routes.get(spec.binding) ?? []
        list.push({ instance, method: spec.handlerName, extract: compileArgs(spec.parameters) })
        routes.set(spec.binding, list)
      }
    }

    return routes
  }

  #dispatch(binding: ConsumerBinding, routes: Route[]): (message: Message, control: DeliveryControl) => Promise<void> {
    const classifier = buildClassifier({
      notRetryable: binding.notRetryable,
      retryable: binding.retryable,
      classifier: binding.classifier,
    })
    const strategy = blockingRetry(binding.retry ?? { attempts: 1 })

    const schema = binding.schema

    return async (message: Message, control: DeliveryControl): Promise<void> => {
      if (schema !== undefined) {
        const result = validateSchema(schema, message.payload)
        if (!result.ok) {
          // A schema violation is never retryable (same bytes always fail): skip the handler, advance past it.
          this.#runtime.onInvalidMessage?.(result.issues, message, binding.binding)
          await control.commitAdvance()
          return
        }
        // Hand the handler the coerced/defaulted/cleaned value, not the raw payload.
        message = { ...message, payload: result.value }
      }

      for (const route of routes) {
        const delivery = new EngineDelivery(binding, route, message, control, classifier, this.#bus, this.#runtime)
        await strategy.dispatch(delivery)
      }
    }
  }
}

/** Bridges the binder's {@link DeliveryControl} + one route into the portable {@link RetryDelivery} contract. */
class EngineDelivery implements RetryDelivery {
  readonly message: Message
  readonly source: string
  readonly initialAttempt: number

  #currentAttempt = 1
  #acked = false
  #nacked = false
  #nackDelay?: number

  readonly #binding: ConsumerBinding
  readonly #route: Route
  readonly #control: DeliveryControl
  readonly #classifier: ErrorClassifier
  readonly #bus: MessageBus
  readonly #runtime: MessagingRuntime

  constructor(
    binding: ConsumerBinding,
    route: Route,
    message: Message,
    control: DeliveryControl,
    classifier: ErrorClassifier,
    bus: MessageBus,
    runtime: MessagingRuntime,
  ) {
    this.#binding = binding
    this.#route = route
    this.message = message
    this.#control = control
    this.#classifier = classifier
    this.#bus = bus
    this.#runtime = runtime
    this.source = control.source
    this.initialAttempt = control.attempt
  }

  get acked(): boolean {
    return this.#acked
  }

  get nacked(): boolean {
    return this.#nacked
  }

  get nackDelay(): number | undefined {
    return this.#nackDelay
  }

  reset(attempt: number): void {
    this.#currentAttempt = attempt
    this.#acked = false
    this.#nacked = false
    this.#nackDelay = undefined
  }

  async invoke(): Promise<void> {
    const ctx = new MessageContextImpl(this.message, this.#currentAttempt, this.#binding.binding, this.#bus)
    const args = await this.#route.extract(this.message, ctx)
    await this.#route.instance[this.#route.method](...args)
    const signals = ctx[kSignals]
    this.#acked = signals.acked
    this.#nacked = signals.nacked
    this.#nackDelay = signals.nackDelay
  }

  classify(error: unknown, attempt: number): boolean {
    return this.#classifier(error, attempt)
  }

  sleepUntilReady(): Promise<void> {
    return this.#control.sleepUntilReady()
  }

  forward(destination: string, headers?: Record<string, string>): Promise<void> {
    return this.#control.forward(destination, headers)
  }

  async recover(error: unknown): Promise<void> {
    // Portable terminal path: fire the observation hook, then the user's recoverer (e.g. bus.send to a DLT
    // binding). Binder packages may additionally attach wire-level dead-letter recovery of their own.
    const ctx: RecoverContext = {
      attempt: this.#currentAttempt,
      group: this.#binding.group ?? '',
      binder: this.#binding.via,
    }
    this.#runtime.onError?.(error, this.message, ctx)
    await this.#runtime.recoverer?.(error, this.message, ctx)
  }

  commitSuccess(): Promise<void> {
    return this.#control.commitSuccess()
  }

  commitAdvance(): Promise<void> {
    return this.#control.commitAdvance()
  }
}
