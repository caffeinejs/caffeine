import type { Container, Ctor } from '@caffeinejs/di'
import {
  FeatureBuilder,
  kFeatureName,
  type AnySchema,
  type FeatureConfigureKit,
  type FeatureConfigurer,
} from '@caffeinejs/std'

import type { Binder } from './binder.js'
import type { ConsumerBinding, ProducerBinding } from './binding.js'
import { MessageBus } from './bus.js'
import type { BindingConfig, MessagingConfigSlice } from './config.js'
import { MessagingContainer } from './engine.js'
import type { ErrorClassifier, RetryPolicy } from './error_handling.js'
import { ErrMissingDestination } from './errors.js'
import { MessagingLifecycle } from './lifecycle.js'
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
 * `ready()` its bootstrap builds the runtime and binds the engine + `MessageBus` into the container.
 * A second integration is `.with(messaging('audit', m => ...))`.
 *
 * Configuration overlays what `.in(...)` / `.out(...)` set for everything a binding's config slice
 * declares: a destination written in code is a default a deployment can redirect once {@link config}
 * is wired.
 */
export class MessagingBuilder<C = unknown> extends FeatureBuilder<C> {
  get [kFeatureName](): string {
    return this.#name === DEFAULT_BINDER ? 'messaging' : `messaging:${this.#name}`
  }

  #config: Partial<MessagingConfigSlice> | undefined
  readonly #name: string
  readonly #binders = new Map<string, Binder | BinderFactory>()
  readonly #inbound = new Map<string, InBindingOptions>()
  readonly #outbound = new Map<string, OutBindingOptions>()
  #onInvalidMessage?: InvalidMessageHandler
  #onError?: ErrorObserver
  #recoverer?: Recoverer

  constructor(name: string = DEFAULT_BINDER, configure?: FeatureConfigurer<never, C>) {
    super(configure)
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

  /**
   * Reads the declared bindings' configurable halves from a node of the configuration tree, e.g.
   * `config.app.messaging`.
   *
   * Applied **over** what `.in(...)` / `.out(...)` set, so a destination written in code is a default. Only
   * bindings the builder declared are resolved: a binding named in the tree that no `.in(...)` created has
   * nothing to attach to, and declaring one is a code act.
   */
  config(config: Partial<MessagingConfigSlice>): this {
    this.#config = config
    return this
  }

  protected override configure(kit: FeatureConfigureKit<C>): void {
    const binders = new Map<string, Binder>()
    for (const [name, binder] of this.#binders) {
      binders.set(name, typeof binder === 'function' ? binder(name) : binder)
    }

    const inbound = bindingsOf(this.#inbound, this.#config?.in) as Map<string, ConsumerBinding>
    const outbound = bindingsOf(this.#outbound, this.#config?.out) as Map<string, ProducerBinding>
    const rKey = runtimeKey(this.#name)
    const bKey = busKey(this.#name)

    kit.container.bind(rKey, t =>
      t.toFactory((ctx): MessagingRuntime => ({
        container: ctx.container as Container,
        binders,
        inbound,
        outbound,
        ...(this.#onInvalidMessage !== undefined ? { onInvalidMessage: this.#onInvalidMessage } : {}),
        ...(this.#onError !== undefined ? { onError: this.#onError } : {}),
        ...(this.#recoverer !== undefined ? { recoverer: this.#recoverer } : {}),
      })),
    )

    if (this.#name === DEFAULT_BINDER) {
      kit.container.bind(MessageBus, t => t.toClass(MessageBus, [rKey]).names(bKey))
    } else {
      kit.container.bind(bKey, t => t.toClass(MessageBus, [rKey]))
    }

    kit.container.bind(containerKey(this.#name), t =>
      t.toClass(MessagingContainer, [rKey, bKey]).labels(Keys.MESSAGING_CONTAINER),
    )

    // Registered once, covering every configured instance: starts every engine on `container.init()` and
    // stops it on `container.dispose()`. `.fallback()` so a second named instance does not fight the first.
    kit.container.bind(MessagingLifecycle, t => t.toFactory(ctx => new MessagingLifecycle(ctx.container)).fallback())
  }
}

function bindingsOf(
  declared: ReadonlyMap<string, InBindingOptions | OutBindingOptions>,
  configured: Partial<Record<string, BindingConfig>> | undefined,
): Map<string, ConsumerBinding | ProducerBinding> {
  const out = new Map<string, ConsumerBinding | ProducerBinding>()

  for (const [binding, options] of declared) {
    const merged = { binding, ...options, ...configured?.[binding] } as ConsumerBinding | ProducerBinding

    // Checked here rather than on the builder: the destination may arrive from any source, so the only
    // moment the answer is known is once the whole chain has merged.
    if (merged.destination === undefined || merged.destination.length === 0) {
      throw new ErrMissingDestination(binding)
    }

    out.set(binding, merged)
  }

  return out
}
