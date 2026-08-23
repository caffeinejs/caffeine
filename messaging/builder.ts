import type { Ctor } from '@caffeinejs/di'
import { kServiceConfigure, type Service, type ServiceKit, AnySchema } from '@caffeinejs/std'
import type { Binder } from './binder.js'
import type { ConsumerBinding, ProducerBinding } from './binding.js'
import { MessageBus } from './bus.js'
import { MessagingContainer } from './engine.js'
import type { ErrorClassifier, RetryPolicy } from './error_handling.js'
import { ErrMissingDestination } from './errors.js'
import type { ErrorObserver, InvalidMessageHandler, MessagingRuntime, Recoverer } from './runtime.js'
import { busKey, containerKey, DEFAULT_BINDER, Keys, runtimeKey } from './symbols.js'

/** Builds a binder instance for a given instance name. Passed to {@link MessagingBuilder.use}. */
export type BinderFactory = (name: string) => Binder

/** Options for an inbound (`.in`) binding declaration. */
export interface InBindingOptions {
  destination: string
  via: string
  group?: string
  contentType?: string
  schema?: AnySchema
  retry?: RetryPolicy
  notRetryable?: Ctor<Error>[]
  retryable?: Ctor<Error>[]
  classifier?: ErrorClassifier
  options?: Record<string, unknown>
}

/** Options for an outbound (`.out`) binding declaration. */
export interface OutBindingOptions {
  destination: string
  via: string
  contentType?: string
  schema?: AnySchema
  options?: Record<string, unknown>
}

/**
 * Fluent configuration for one messaging integration: register binder instances with {@link use}, then declare
 * inbound ({@link in}) and outbound ({@link out}) bindings that map logical names onto binder destinations. At
 * `ready()` its `[kServiceConfigure]` builds the runtime and binds the engine + `MessageBus` into the container.
 */
export class MessagingBuilder implements Service {
  readonly #name: string
  readonly #binders = new Map<string, Binder | BinderFactory>()
  readonly #inbound = new Map<string, InBindingOptions>()
  readonly #outbound = new Map<string, OutBindingOptions>()
  #onInvalidMessage?: InvalidMessageHandler
  #onError?: ErrorObserver
  #recoverer?: Recoverer

  constructor(name: string) {
    this.#name = name
  }

  /** Handles inbound messages that fail their binding's schema (runs instead of the handler; skips + advances). */
  onInvalidMessage(handler: InvalidMessageHandler): this {
    this.#onInvalidMessage = handler
    return this
  }

  /** Observation hook fired when the pipeline gives up on a message (logging/metrics); does not decide recovery. */
  onError(observer: ErrorObserver): this {
    this.#onError = observer
    return this
  }

  /** Terminal recoverer invoked once retries are exhausted; e.g. `bus.send` the failed message to a DLT binding. */
  recoverer(recoverer: Recoverer): this {
    this.#recoverer = recoverer
    return this
  }

  /** Registers a binder instance under `name`; a binding's `via` selects it. Accepts a binder or a factory. */
  use(name: string, binder: Binder | BinderFactory): this {
    this.#binders.set(name, binder)
    return this
  }

  /** Declares an inbound binding: a logical name `@Consume` attaches to, mapped to a binder destination. */
  in(binding: string, options: InBindingOptions): this {
    this.#inbound.set(binding, options)
    return this
  }

  /** Declares an outbound binding: a logical name `bus.send` publishes to, mapped to a binder destination. */
  out(binding: string, options: OutBindingOptions): this {
    this.#outbound.set(binding, options)
    return this
  }

  [kServiceConfigure](kit: ServiceKit): Promise<void> {
    const binders = new Map<string, Binder>()
    for (const [name, binder] of this.#binders) {
      binders.set(name, typeof binder === 'function' ? binder(name) : binder)
    }

    const inbound = new Map<string, ConsumerBinding>()
    for (const [binding, options] of this.#inbound) {
      if (options.destination.length === 0) {
        return Promise.reject(new ErrMissingDestination(binding))
      }
      inbound.set(binding, { binding, ...options })
    }

    const outbound = new Map<string, ProducerBinding>()
    for (const [binding, options] of this.#outbound) {
      if (options.destination.length === 0) {
        return Promise.reject(new ErrMissingDestination(binding))
      }
      outbound.set(binding, { binding, ...options })
    }

    const runtime: MessagingRuntime = {
      container: kit.container,
      binders,
      inbound,
      outbound,
      ...(this.#onInvalidMessage !== undefined ? { onInvalidMessage: this.#onInvalidMessage } : {}),
      ...(this.#onError !== undefined ? { onError: this.#onError } : {}),
      ...(this.#recoverer !== undefined ? { recoverer: this.#recoverer } : {}),
    }
    const rKey = runtimeKey(this.#name)
    const bKey = busKey(this.#name)

    kit.container.bind(rKey).toValue(runtime)

    if (this.#name === DEFAULT_BINDER) {
      kit.container.bind(MessageBus).toClass(MessageBus, [rKey]).names(bKey)
    } else {
      kit.container.bind(bKey).toClass(MessageBus, [rKey])
    }

    kit.container
      .bind(containerKey(this.#name))
      .toClass(MessagingContainer, [rKey, bKey])
      .labels(Keys.MESSAGING_CONTAINER)

    return Promise.resolve()
  }
}
