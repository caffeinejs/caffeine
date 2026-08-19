import type { ParameterPickOptions } from '@caffeinejs/std/framework'
import type { KafkaDeserializers, KafkaMessage } from '../config.js'
import type { DeadLetterOptions, RetryPolicy } from '../error_handling.js'

/**
 * The frozen, read-only output of a {@link ListenerBuilder} — the shape the runtime container consumes when
 * planning consumers. Analogous to the HTTP `RouteSpec` produced by `RouteBuilder.toRoute()`.
 */
export interface ListenerSpec {
  /** Method name on the handler class to invoke for each message. */
  handlerName: string | symbol
  /** Topics this method subscribes to. */
  topics: string[]
  /** Consumer group id; falls back to the plugin default when omitted. */
  groupId?: string
  /** Overrides the consumer autocommit behaviour for this listener. */
  autocommit?: boolean | number
  /** Ordered parameter pickers (from `@KafkaParams`); when absent the handler receives the raw message. */
  parameters?: ParameterPickOptions<KafkaMessage>[]
  /** Per-listener retry policy (from `@KafkaRetry`); overrides the instance default. */
  retry?: RetryPolicy
  /** Per-listener dead-letter config (from `@KafkaDeadLetter`); overrides the instance default. */
  deadLetter?: DeadLetterOptions | boolean
  /** Per-listener deserializers; groups this listener into its own consumer. */
  deserializers?: KafkaDeserializers
}

/**
 * Accumulates a single `@KafkaListener` method's configuration across the decorators applied to it, then
 * freezes it via {@link toListener}. Mirrors the HTTP `RouteBuilder` in
 * `http/decorators/registrar/routing.ts`: private fields, fluent setters returning `this`, a `to*()` freezer.
 */
export class ListenerBuilder {
  #handlerName?: string | symbol
  #topics?: string[]
  #groupId?: string
  #autocommit?: boolean | number
  #parameters?: ParameterPickOptions<KafkaMessage>[]
  #retry?: RetryPolicy
  #deadLetter?: DeadLetterOptions | boolean
  #deserializers?: KafkaDeserializers

  handler(handler: string | symbol): this {
    this.#handlerName = handler
    return this
  }

  topics(topics: string | string[]): this {
    this.#topics ??= []
    this.#topics.push(...(Array.isArray(topics) ? topics : [topics]))
    return this
  }

  groupId(groupId: string): this {
    this.#groupId = groupId
    return this
  }

  autocommit(autocommit: boolean | number): this {
    this.#autocommit = autocommit
    return this
  }

  parameters(parameters: ParameterPickOptions<KafkaMessage> | ParameterPickOptions<KafkaMessage>[]): this {
    this.#parameters ??= []
    this.#parameters.push(...(Array.isArray(parameters) ? parameters : [parameters]))
    return this
  }

  retry(policy: RetryPolicy): this {
    this.#retry = policy
    return this
  }

  deadLetter(deadLetter: DeadLetterOptions | boolean): this {
    this.#deadLetter = deadLetter
    return this
  }

  deserializers(deserializers: KafkaDeserializers): this {
    this.#deserializers = deserializers
    return this
  }

  toListener(): ListenerSpec {
    return {
      handlerName: this.#handlerName ?? '',
      topics: [...(this.#topics ?? [])],
      groupId: this.#groupId,
      autocommit: this.#autocommit,
      parameters: this.#parameters === undefined ? undefined : [...this.#parameters],
      retry: this.#retry,
      deadLetter: this.#deadLetter,
      deserializers: this.#deserializers,
    }
  }
}

// Keyed by `context.metadata` (per decorated class), then by method name — the same WeakMap idiom the HTTP
// package uses so method decorators can accumulate into one builder before the class decorator runs.
const ListenerRegistry = new WeakMap<object, Map<string | symbol, ListenerBuilder>>()

// Keyed by the class constructor: the frozen specs harvested when `@KafkaHandler` runs. The runtime container
// reads this by the binding's `type` (ctor), exactly as HTTP's `getRouter(key)` does.
const HandlerRegistry = new WeakMap<Function, ListenerSpec[]>()

/** Records/merges a listener's config for a decorated method. Called by `@KafkaListener`/`@KafkaParams`/… */
export function configureListener(
  ctx: ClassMethodDecoratorContext,
  mut: (builder: ListenerBuilder) => void,
): void {
  let listeners = ListenerRegistry.get(ctx.metadata)
  if (!listeners) {
    listeners = new Map<string | symbol, ListenerBuilder>()
    ListenerRegistry.set(ctx.metadata, listeners)
  }

  let builder = listeners.get(ctx.name)
  if (!builder) {
    builder = new ListenerBuilder()
    listeners.set(ctx.name, builder)
  }

  mut(builder)
}

/**
 * Harvests the listener builders accumulated on a class's metadata, freezes each, and keys them by the class
 * constructor. Called by `@KafkaHandler` after the method decorators have run.
 */
export function registerHandler(metadata: object, target: Function): void {
  const builders = ListenerRegistry.get(metadata)
  HandlerRegistry.set(target, Array.from(builders?.values() ?? [], builder => builder.toListener()))
}

/** Returns the frozen listener specs declared on a handler class, or an empty array when there are none. */
export function getHandlerListeners(key: Function): ListenerSpec[] {
  return HandlerRegistry.get(key) ?? []
}
