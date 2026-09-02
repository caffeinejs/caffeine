import type { Ctor } from '@caffeinejs/di'
import { type ServiceBeforeBootstrapIn, type Service, type ServiceAPI, AnySchema, ServiceBootstrapIn } from '@caffeinejs/std'
import {
  defineFeatureConfig,
  instanceNamespace,
  type ConfigAccessors,
  type ConfigHandle,
  type ConfigSlice,
} from '@caffeinejs/std/config'
import {
  BINDING_CONFIG_KEYS,
  MESSAGING_CONFIG_NAMESPACE,
  messagingConfigSchema,
  type BindingConfig,
  type MessagingConfigSlice,
} from './config.js'
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
 * `ready()` its `configure()` builds the runtime and binds the engine + `MessageBus` into the container.
 * A second integration is another `.messaging()` call whose builder is named with {@link named}.
 */
export class MessagingBuilder<C = unknown> implements Service {
  #name: string = DEFAULT_BINDER
  #selector?: (c: ConfigHandle<C>) => ConfigAccessors<MessagingConfigSlice>
  readonly #binders = new Map<string, Binder | BinderFactory>()
  readonly #inbound = new Map<string, InBindingOptions>()
  readonly #outbound = new Map<string, OutBindingOptions>()
  #onInvalidMessage?: InvalidMessageHandler
  #onError?: ErrorObserver
  #recoverer?: Recoverer
  #resolved?: ConfigSlice<{ inbound: Map<string, ConsumerBinding>, outbound: Map<string, ProducerBinding> }>

  get name(): string {
    return 'messaging'
  }

  /**
   * Names this integration. The unnamed call is the default instance (`messaging.default.*`);
   * `m.named('audit')` reads `messaging.audit.*`.
   */
  named(name: string): ServiceAPI<this> {
    this.#name = name
    return this
  }

  /** Handles inbound messages that fail their binding's schema (runs instead of the handler; skips + advances). */
  onInvalidMessage(handler: InvalidMessageHandler): ServiceAPI<this> {
    this.#onInvalidMessage = handler
    return this
  }

  /** Observation hook fired when the pipeline gives up on a message (logging/metrics); does not decide recovery. */
  onError(observer: ErrorObserver): ServiceAPI<this> {
    this.#onError = observer
    return this
  }

  /** Terminal recoverer invoked once retries are exhausted; e.g. `bus.send` the failed message to a DLT binding. */
  recoverer(recoverer: Recoverer): ServiceAPI<this> {
    this.#recoverer = recoverer
    return this
  }

  /** Registers a binder instance under `name`; a binding's `via` selects it. Accepts a binder or a factory. */
  use(name: string, binder: Binder | BinderFactory): ServiceAPI<this> {
    this.#binders.set(name, binder)
    return this
  }

  /** Declares an inbound binding: a logical name `@Consume` attaches to, mapped to a binder destination. */
  in(binding: string, options: InBindingOptions): ServiceAPI<this> {
    this.#inbound.set(binding, options)
    return this
  }

  /** Declares an outbound binding: a logical name `bus.send` publishes to, mapped to a binder destination. */
  out(binding: string, options: OutBindingOptions): ServiceAPI<this> {
    this.#outbound.set(binding, options)
    return this
  }

  /**
   * Places this instance's settings elsewhere in the configuration tree, e.g. `m.config(c => c.app.events)`.
   *
   * The selector names a location, not a value: it is evaluated once, at configure time, to record the path.
   */
  config(selector: (c: ConfigHandle<C>) => ConfigAccessors<MessagingConfigSlice>): ServiceAPI<this> {
    this.#selector = selector
    return this
  }

  beforeBootstrap(kit: ServiceBeforeBootstrapIn): void {
    const slice = defineFeatureConfig<MessagingConfigSlice>(kit.config, {
      namespace: instanceNamespace(MESSAGING_CONFIG_NAMESPACE, this.#name),
      selector: this.#selector as ((c: never) => unknown) | undefined,
      schema: messagingConfigSchema,
      values: {
        in: configurableHalf(this.#inbound),
        out: configurableHalf(this.#outbound),
      },
    })

    const code = { in: this.#inbound, out: this.#outbound }

    this.#resolved = slice.derive(published => ({
      // Only the bindings the builder declared are resolved. A binding named in the tree that no `.in(...)`
      // created has nothing to attach to and is read by nothing — declaring one is a code act.
      inbound: bindingsOf(code.in, published.in) as Map<string, ConsumerBinding>,
      outbound: bindingsOf(code.out, published.out) as Map<string, ProducerBinding>,
    }))
  }

  bootstrap(kit: ServiceBootstrapIn): Promise<void> {
    const binders = new Map<string, Binder>()
    for (const [name, binder] of this.#binders) {
      binders.set(name, typeof binder === 'function' ? binder(name) : binder)
    }

    const resolved = this.#resolved!
    const rKey = runtimeKey(this.#name)
    const bKey = busKey(this.#name)
    const container = kit.container

    kit.container
      .bind(rKey)
      .toValue<MessagingRuntime>({
        container,
        binders,
        inbound: resolved.config.inbound,
        outbound: resolved.config.outbound,
        ...(this.#onInvalidMessage !== undefined ? { onInvalidMessage: this.#onInvalidMessage } : {}),
        ...(this.#onError !== undefined ? { onError: this.#onError } : {}),
        ...(this.#recoverer !== undefined ? { recoverer: this.#recoverer } : {}),
      })

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

/** The half of each declared binding that can travel through the tree, keyed by binding name. */
function configurableHalf(
  declared: ReadonlyMap<string, InBindingOptions | OutBindingOptions>,
): Record<string, BindingConfig> | undefined {
  if (declared.size === 0) {
    return undefined
  }

  const out: Record<string, BindingConfig> = {}

  for (const [binding, options] of declared) {
    const held = options as unknown as Record<string, unknown>

    out[binding] = Object.fromEntries(
      BINDING_CONFIG_KEYS
        .filter(key => held[key] !== undefined)
        .map(key => [key, held[key]]),
    )
  }

  return out
}

/**
 * Folds each declared binding together with whatever configuration said about it.
 *
 * Code first, configuration over it — a builder value is a default here as everywhere else — and the
 * code-only members (`schema`, `classifier`, the error constructors) ride through untouched.
 */
function bindingsOf(
  declared: ReadonlyMap<string, InBindingOptions | OutBindingOptions>,
  configured: Record<string, BindingConfig> | undefined,
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
